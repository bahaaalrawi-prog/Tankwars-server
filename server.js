const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve client static files
app.use(express.static(path.join(__dirname, 'client')));

// Game settings & Constants
const PORT = process.env.PORT || 3000;
const TICK_RATE = 30; // 30 ticks per second
const TILE_SIZE = 50;
const MAP_TILES = 30; // 30x30 grid
const MAP_SIZE = MAP_TILES * TILE_SIZE; // 1500px
const TANK_SIZE = 36;
const TANK_HALF = TANK_SIZE / 2;
const BULLET_SIZE = 6;
const BULLET_SPEED = 12;

// Tile types
const TILE_EMPTY = 0;
const TILE_DESTRUCTIBLE = 1;
const TILE_INDESTRUCTIBLE = 4;
const TILE_WATER = 5;
const TILE_FOREST = 6;

// Team settings
const TEAMS = {
  RED: { name: 'RED', color: '#ff0055', spawn: { x: 3.5 * TILE_SIZE, y: 3.5 * TILE_SIZE }, base: { x: 1, y: 1 } },
  BLUE: { name: 'BLUE', color: '#00ccff', spawn: { x: 26.5 * TILE_SIZE, y: 3.5 * TILE_SIZE }, base: { x: 28, y: 1 } },
  GREEN: { name: 'GREEN', color: '#00ff66', spawn: { x: 3.5 * TILE_SIZE, y: 26.5 * TILE_SIZE }, base: { x: 1, y: 28 } },
  YELLOW: { name: 'YELLOW', color: '#ffcc00', spawn: { x: 26.5 * TILE_SIZE, y: 26.5 * TILE_SIZE }, base: { x: 28, y: 28 } }
};

// Rooms database
const rooms = {};

// Helper: Broadcast to all players in a room
function broadcast(roomId, event, data) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = JSON.stringify({ event, data });
  Object.keys(room.players).forEach(pid => {
    const ws = room.playerSockets[pid];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

function fireBullet(room, tank) {
  const now = Date.now();
  if (tank.ammo === undefined) tank.ammo = 6;
  if (tank.reloadStartTime === undefined) tank.reloadStartTime = null;
  if (tank.recentShots === undefined) tank.recentShots = [];

  // Update reload state
  if (tank.reloadStartTime !== null) {
    const elapsed = now - tank.reloadStartTime;
    if (elapsed >= 3000) {
      tank.ammo = 6;
      tank.reloadStartTime = null;
      tank.reloadTimeLeft = 0;
    } else {
      return false; // Reloading, block fire
    }
  }

  // Rate limiting (players only, to avoid bot lag/glitches)
  if (!tank.isBot) {
    tank.recentShots = tank.recentShots.filter(t => now - t < 3000);
    if (tank.recentShots.length >= 6) {
      console.warn(`WARNING: Player ${tank.name} (${tank.id}) exceeded rate-limit: ${tank.recentShots.length} shots in 3 seconds!`);
      return false;
    }
  }

  if (tank.ammo <= 0) {
    if (tank.reloadStartTime === null) {
      tank.reloadStartTime = now;
    }
    return false;
  }

  // Deduct ammo
  tank.ammo--;
  if (!tank.isBot) {
    tank.recentShots.push(now);
  }

  if (tank.ammo <= 0) {
    tank.ammo = 0;
    tank.reloadStartTime = now;
  }

  // Create bullet object
  const barrelLength = TANK_HALF + 8;
  const bx = tank.x + Math.cos(tank.turretAngle) * barrelLength;
  const by = tank.y + Math.sin(tank.turretAngle) * barrelLength;
  const vx = Math.cos(tank.turretAngle) * BULLET_SPEED;
  const vy = Math.sin(tank.turretAngle) * BULLET_SPEED;
  const bulletId = Math.random().toString(36).substring(2, 9);

  room.bullets.push({
    id: bulletId,
    ownerId: tank.id,
    team: tank.team,
    x: bx,
    y: by,
    vx,
    vy
  });

  broadcast(room.id, 'bullet_fired', { playerId: tank.id });
  return true;
}

// Procedural Map Generator
function generateMap(type) {
  const grid = Array(MAP_TILES).fill(null).map(() => Array(MAP_TILES).fill(TILE_EMPTY));
  const destructibleWalls = {}; // Stores wall HP ("x,y": hp)

  // 1. Add bases HQs
  const basePositions = [
    { x: 1, y: 1 },
    { x: 28, y: 1 },
    { x: 1, y: 28 },
    { x: 28, y: 28 }
  ];

  // Base defense structures (fully surrounding the base with a 1-tile gap facing the center of the map)
  const baseDefenses = [
    { base: { x: 1, y: 1 }, walls: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }] },
    { base: { x: 28, y: 1 }, walls: [{ x: 27, y: 0 }, { x: 28, y: 0 }, { x: 29, y: 0 }, { x: 27, y: 1 }, { x: 29, y: 1 }, { x: 28, y: 2 }, { x: 29, y: 2 }] },
    { base: { x: 1, y: 28 }, walls: [{ x: 0, y: 27 }, { x: 1, y: 27 }, { x: 0, y: 28 }, { x: 2, y: 28 }, { x: 0, y: 29 }, { x: 1, y: 29 }, { x: 2, y: 29 }] },
    { base: { x: 28, y: 28 }, walls: [{ x: 28, y: 27 }, { x: 29, y: 27 }, { x: 27, y: 28 }, { x: 29, y: 28 }, { x: 27, y: 29 }, { x: 28, y: 29 }, { x: 29, y: 29 }] }
  ];

  // Apply base defenses (Initial HP is 3)
  baseDefenses.forEach(def => {
    def.walls.forEach(w => {
      grid[w.y][w.x] = TILE_DESTRUCTIBLE;
      destructibleWalls[`${w.x},${w.y}`] = 3;
    });
  });

  // Keep spawn areas clear (3x3 area around each spawn point: RED (3,3), BLUE (26,3), GREEN (3,26), YELLOW (26,26))
  const isSpawnZone = (x, y) => {
    return (
      (x >= 2 && x <= 4 && y >= 2 && y <= 4) || // RED spawn area
      (x >= 25 && x <= 27 && y >= 2 && y <= 4) || // BLUE spawn area
      (x >= 2 && x <= 4 && y >= 25 && y <= 27) || // GREEN spawn area
      (x >= 25 && x <= 27 && y >= 25 && y <= 27) // YELLOW spawn area
    );
  };

  const isBaseDefenseWall = (x, y) => {
    return baseDefenses.some(def =>
      def.walls.some(w => w.x === x && w.y === y)
    );
  };

  // Generate obstacles based on map type
  for (let y = 0; y < MAP_TILES; y++) {
    for (let x = 0; x < MAP_TILES; x++) {
      // Don't place obstacles in spawn zones, base positions, or base defense walls
      if (isSpawnZone(x, y)) continue;
      if (basePositions.some(bp => bp.x === x && bp.y === y)) continue;
      if (isBaseDefenseWall(x, y)) continue;

      switch (type) {
        case 'open_field': // Mostly clear, large corridors, sparse walls
          if (Math.random() < 0.12) {
            grid[y][x] = TILE_DESTRUCTIBLE;
            destructibleWalls[`${x},${y}`] = 3;
          } else if (Math.random() < 0.03) {
            grid[y][x] = TILE_INDESTRUCTIBLE;
          } else if (Math.random() < 0.02) {
            grid[y][x] = TILE_FOREST;
          }
          break;

        case 'maze': // Complex grid of indestructible walls with destructible blocking blocks
          if (x % 4 === 0 && y % 4 === 0) {
            grid[y][x] = TILE_INDESTRUCTIBLE;
          } else if ((x % 2 === 0 || y % 2 === 0) && Math.random() < 0.25) {
            grid[y][x] = TILE_DESTRUCTIBLE;
            destructibleWalls[`${x},${y}`] = 3;
          } else if (Math.random() < 0.05) {
            grid[y][x] = TILE_FOREST;
          }
          break;

        case 'city': // Blocks of buildings (indestructible) and alleyways
          const blockX = Math.floor(x / 3);
          const blockY = Math.floor(y / 3);
          if (blockX % 2 === 1 && blockY % 2 === 1) {
            // inside a block building
            if (x % 3 !== 1 || y % 3 !== 1) {
              grid[y][x] = TILE_INDESTRUCTIBLE;
            } else {
              grid[y][x] = TILE_DESTRUCTIBLE;
              destructibleWalls[`${x},${y}`] = 3;
            }
          } else {
            // roads
            if (Math.random() < 0.05) {
              grid[y][x] = TILE_DESTRUCTIBLE;
              destructibleWalls[`${x},${y}`] = 3;
            } else if (Math.random() < 0.05) {
              grid[y][x] = TILE_FOREST;
            }
          }
          break;

        case 'bridges': // Water cross in middle, dividing the map. Bridges at middle paths.
          const mid = Math.floor(MAP_TILES / 2);
          const isBridge = (x === mid && (y === 5 || y === 24)) || (y === mid && (x === 5 || x === 24)) ||
                           ((x === mid || x === mid - 1) && (y === mid || y === mid - 1));
          
          if ((x === mid || x === mid - 1 || y === mid || y === mid - 1) && !isBridge) {
            grid[y][x] = TILE_WATER;
          } else {
            // Standard placement in quadrants
            if (Math.random() < 0.15) {
              grid[y][x] = TILE_DESTRUCTIBLE;
              destructibleWalls[`${x},${y}`] = 3;
            } else if (Math.random() < 0.04) {
              grid[y][x] = TILE_INDESTRUCTIBLE;
            } else if (Math.random() < 0.08) {
              grid[y][x] = TILE_FOREST;
            }
          }
          break;

        case 'desert': // Random clusters, sand, abysses (water)
          const noise = Math.sin(x * 0.4) * Math.cos(y * 0.4);
          if (noise > 0.5) {
            grid[y][x] = TILE_WATER;
          } else if (noise < -0.3) {
            grid[y][x] = TILE_DESTRUCTIBLE;
            destructibleWalls[`${x},${y}`] = 3;
          } else if (Math.random() < 0.05) {
            grid[y][x] = TILE_INDESTRUCTIBLE;
          } else if (Math.random() < 0.05) {
            grid[y][x] = TILE_FOREST;
          }
          break;
      }
    }
  }

  return { grid, destructibleWalls };
}

// Check if tank bounding box collides with map obstacles
function checkTankCollision(x, y, grid) {
  // Bounding box edges
  const left = x - TANK_HALF;
  const right = x + TANK_HALF;
  const top = y - TANK_HALF;
  const bottom = y + TANK_HALF;

  // Check out of bounds
  if (left < 0 || right > MAP_SIZE || top < 0 || bottom > MAP_SIZE) {
    return { collision: true, type: 'border' };
  }

  // Get range of tiles overlapping tank
  const startX = Math.max(0, Math.floor(left / TILE_SIZE));
  const endX = Math.min(MAP_TILES - 1, Math.floor(right / TILE_SIZE));
  const startY = Math.max(0, Math.floor(top / TILE_SIZE));
  const endY = Math.min(MAP_TILES - 1, Math.floor(bottom / TILE_SIZE));

  for (let ty = startY; ty <= endY; ty++) {
    for (let tx = startX; tx <= endX; tx++) {
      const tile = grid[ty][tx];
      if (tile === TILE_DESTRUCTIBLE || tile === TILE_INDESTRUCTIBLE) {
        return { collision: true, type: 'wall', tx, ty };
      }
      if (tile === TILE_WATER) {
        return { collision: true, type: 'water', tx, ty }; // Water is solid & deadly
      }
    }
  }

  return { collision: false };
}

// Manage Room Actions
function initRoom(roomId, mapType = 'city', roundDuration = 300) {
  const { grid, destructibleWalls } = generateMap(mapType);
  rooms[roomId] = {
    id: roomId,
    players: {},
    playerSockets: {}, // Maps playerId -> WS connection
    bullets: [],
    powerups: [],
    destructibleWalls,
    grid,
    mapType,
    timer: roundDuration, // in seconds
    state: 'LOBBY', // LOBBY, PLAYING, GAMEOVER
    bases: {
      RED: { hp: 3, x: 1, y: 1 },
      BLUE: { hp: 3, x: 28, y: 1 },
      GREEN: { hp: 3, x: 1, y: 28 },
      YELLOW: { hp: 3, x: 28, y: 28 }
    },
    teamsScore: { RED: 0, BLUE: 0, GREEN: 0, YELLOW: 0 },
    spawnPowerupCooldown: 10 * TICK_RATE, // Initial delay before spawning
    winnerTeam: null
  };
}

// Balance teams automatically based on players inside the room
function assignTeam(room, requestedTeam) {
  const counts = { RED: 0, BLUE: 0, GREEN: 0, YELLOW: 0 };
  Object.values(room.players).forEach(p => {
    counts[p.team]++;
  });

  // If player requested a valid team and it's not overly crowded, assign it
  if (requestedTeam && TEAMS[requestedTeam] && counts[requestedTeam] < 2) {
    return requestedTeam;
  }

  // Find team with lowest player count
  let minTeam = 'RED';
  let minCount = Infinity;
  Object.keys(TEAMS).forEach(team => {
    if (counts[team] < minCount) {
      minCount = counts[team];
      minTeam = team;
    }
  });

  return minTeam;
}

// AI Bot behavior state machine
function updateBotAI(room, bot) {
  if (bot.isDead) return;

  const now = Date.now();
  bot.botChangeDirTimer = (bot.botChangeDirTimer || 0) + 1;
  bot.botShootTimer = (bot.botShootTimer || 0) + 1;

  // 1. Move Bot
  let speed = bot.speedActive ? 5.5 : 3.0; // Bots are slightly slower than human default to balance
  let dx = 0, dy = 0;
  
  // Occassionally change direction randomly (every 1.5 - 3.5 seconds) or if stuck
  const changeDirThreshold = (1.5 + Math.random() * 2.0) * TICK_RATE;
  
  let coll = { collision: false };
  
  if (bot.botDir === 'up') dy = -speed;
  else if (bot.botDir === 'down') dy = speed;
  else if (bot.botDir === 'left') dx = -speed;
  else if (bot.botDir === 'right') dx = speed;

  if (dx !== 0 || dy !== 0) {
    coll = checkTankCollision(bot.x + dx, bot.y + dy, room.grid);
  }

  // If stuck or timer expired, select target-directed or random direction
  if (coll.collision || bot.botChangeDirTimer >= changeDirThreshold) {
    bot.botChangeDirTimer = 0;
    const dirs = ['up', 'down', 'left', 'right'];
    
    // 65% chance to move towards nearest enemy target (tank or base), 35% random walk
    if (Math.random() < 0.65) {
      let closestDist = Infinity;
      let targetX = MAP_SIZE / 2;
      let targetY = MAP_SIZE / 2;

      // Find closest opposing Base HQ
      Object.entries(room.bases).forEach(([teamName, base]) => {
        if (teamName !== bot.team && base.hp > 0) {
          const dist = Math.hypot(base.x * TILE_SIZE + 25 - bot.x, base.y * TILE_SIZE + 25 - bot.y);
          if (dist < closestDist) {
            closestDist = dist;
            targetX = base.x * TILE_SIZE + 25;
            targetY = base.y * TILE_SIZE + 25;
          }
        }
      });

      // Find closest opposing Player
      Object.values(room.players).forEach(p => {
        if (p.team !== bot.team && !p.isDead) {
          const dist = Math.hypot(p.x - bot.x, p.y - bot.y);
          if (dist < closestDist) {
            closestDist = dist;
            targetX = p.x;
            targetY = p.y;
          }
        }
      });

      // Choose cardinal direction towards target
      const diffX = targetX - bot.x;
      const diffY = targetY - bot.y;

      if (Math.abs(diffX) > Math.abs(diffY)) {
        bot.botDir = diffX > 0 ? 'right' : 'left';
      } else {
        bot.botDir = diffY > 0 ? 'down' : 'up';
      }
    } else {
      // Pick random
      bot.botDir = dirs[Math.floor(Math.random() * dirs.length)];
    }

    // Set angles
    if (bot.botDir === 'up') bot.angle = -Math.PI / 2;
    else if (bot.botDir === 'down') bot.angle = Math.PI / 2;
    else if (bot.botDir === 'left') bot.angle = Math.PI;
    else if (bot.botDir === 'right') bot.angle = 0;
    
    bot.turretAngle = bot.angle; // Lock turret forward by default
  } else {
    bot.x += dx;
    bot.y += dy;
  }

  // Instant water hazard death
  if (coll.type === 'water') {
    bot.isDead = true;
    bot.hp = 0;
    bot.respawnTime = now + 3000;
    broadcast(room.id, 'player_destroyed', {
      victimId: bot.id,
      victimName: bot.name,
      killerName: 'Water Abyss',
      respawnTime: bot.respawnTime
    });
    return;
  }

  // 2. Targeting and Shooting
  let targetFound = false;
  let targetAngle = bot.angle;

  const checkLineOfSight = (bx, by, tx, ty) => {
    const dist = Math.hypot(tx - bx, ty - by);
    if (dist > 600) return false;

    // Check same corridor with small margin
    const margin = TANK_HALF;
    if (Math.abs(by - ty) < margin) {
      return tx > bx ? 0 : Math.PI;
    } else if (Math.abs(bx - tx) < margin) {
      return ty > by ? Math.PI / 2 : -Math.PI / 2;
    }
    return false;
  };

  // Scan for opposing Bases
  for (const [teamName, base] of Object.entries(room.bases)) {
    if (teamName !== bot.team && base.hp > 0) {
      const bx = base.x * TILE_SIZE + 25;
      const by = base.y * TILE_SIZE + 25;
      const angle = checkLineOfSight(bot.x, bot.y, bx, by);
      if (angle !== false) {
        targetAngle = angle;
        targetFound = true;
        break;
      }
    }
  }

  // Scan for opposing Players
  if (!targetFound) {
    for (const p of Object.values(room.players)) {
      if (p.team !== bot.team && !p.isDead) {
        const angle = checkLineOfSight(bot.x, bot.y, p.x, p.y);
        if (angle !== false) {
          targetAngle = angle;
          targetFound = true;
          break;
        }
      }
    }
  }

  // Shoot trigger
  if (targetFound) {
    bot.turretAngle = targetAngle;
    
    // Shoot delay (1.2 seconds for bots)
    if (bot.botShootTimer >= 1.2 * TICK_RATE) {
      bot.botShootTimer = 0;
      const maxBullets = bot.fireActive ? 2 : 1;
      
      bot.activeBulletsCount = bot.activeBulletsCount || 0;
      if (bot.activeBulletsCount < maxBullets) {
        if (fireBullet(room, bot)) {
          bot.activeBulletsCount++;
        }
      }
    }
  } else {
    // Blast blocking destructible walls in path
    if (coll.type === 'wall' && bot.botShootTimer >= 2.0 * TICK_RATE) {
      bot.botShootTimer = 0;
      bot.activeBulletsCount = bot.activeBulletsCount || 0;
      if (bot.activeBulletsCount < 1) {
        if (fireBullet(room, bot)) {
          bot.activeBulletsCount++;
        }
      }
    }
  }
}

// Game Tick Update Loop
function updateGame(room) {
  if (room.state !== 'PLAYING') return;

  const now = Date.now();
  // Update reload state for all players and bots
  Object.values(room.players).forEach(p => {
    if (p.ammo === undefined) p.ammo = 6;
    if (p.reloadStartTime === undefined) p.reloadStartTime = null;
    if (p.reloadStartTime !== null) {
      const elapsed = now - p.reloadStartTime;
      if (elapsed >= 3000) {
        p.ammo = 6;
        p.reloadStartTime = null;
        p.reloadTimeLeft = 0;
      } else {
        p.reloadTimeLeft = 3000 - elapsed;
      }
    } else {
      p.reloadTimeLeft = 0;
    }
  });

  // 1. Update Game Timer
  room.timerTick = (room.timerTick || 0) + 1;
  if (room.timerTick >= TICK_RATE) {
    room.timerTick = 0;
    if (room.timer > 0) {
      room.timer--;
      if (room.timer <= 0) {
        endGame(room);
      }
    }
  }

  // 2. Spawn Power-ups
  if (room.powerups.length < 5) {
    room.spawnPowerupCooldown--;
    if (room.spawnPowerupCooldown <= 0) {
      room.spawnPowerupCooldown = (15 + Math.random() * 15) * TICK_RATE; // 15-30s spawn rate
      // Find empty spot
      let tx, ty, attempts = 0;
      do {
        tx = Math.floor(Math.random() * MAP_TILES);
        ty = Math.floor(Math.random() * MAP_TILES);
        attempts++;
      } while (
        (room.grid[ty][tx] !== TILE_EMPTY || 
        (tx < 3 && ty < 3) || 
        (tx > 26 && ty < 3) || 
        (tx < 3 && ty > 26) || 
        (tx > 26 && ty > 26)) && attempts < 50
      );

      if (room.grid[ty][tx] === TILE_EMPTY) {
        const types = ['star', 'bomb', 'shield', 'speed', 'fire', 'freeze'];
        const type = types[Math.floor(Math.random() * types.length)];
        const powerupId = Math.random().toString(36).substring(2, 9);
        room.powerups.push({
          id: powerupId,
          type,
          x: tx * TILE_SIZE + TILE_SIZE / 2,
          y: ty * TILE_SIZE + TILE_SIZE / 2
        });
      }
    }
  }

  // 3. Update Player & Bot AI States
  // now is already declared at the top of updateGame
  Object.values(room.players).forEach(player => {
    if (player.isDead) {
      if (now >= player.respawnTime) {
        // Respawn player near base
        player.isDead = false;
        player.hp = 2;
        player.x = TEAMS[player.team].spawn.x;
        player.y = TEAMS[player.team].spawn.y;
        player.angle = player.team === 'RED' || player.team === 'BLUE' ? Math.PI / 2 : -Math.PI / 2;
        player.turretAngle = player.angle;
        player.activeBulletsCount = 0;
        player.starActive = false;
        player.speedActive = false;
        player.fireActive = false;
        player.lastMoveDir = "";
        player.ammo = 6;
        player.reloadStartTime = null;
        player.reloadTimeLeft = 0;
        player.recentShots = [];
        if (player.isBot) {
          player.botDir = player.team === 'RED' || player.team === 'BLUE' ? 'down' : 'up';
          player.botChangeDirTimer = 0;
          player.botShootTimer = 0;
        }
        broadcast(room.id, 'player_respawn', { playerId: player.id, x: player.x, y: player.y });
      }
      return;
    }

    // Run Bot AI update
    if (player.isBot) {
      updateBotAI(room, player);
    } else {
      // Process human player movement tick
      if (player.lastMoveDir && player.lastMoveDir !== "" && !player.frozenActive) {
        let speed = player.speedActive ? 6 : 3.5;
        let dx = 0;
        let dy = 0;
        let moveAngle = player.angle;

        if (player.lastMoveDir === 'up') {
          dy = -speed;
          moveAngle = -Math.PI / 2;
        } else if (player.lastMoveDir === 'down') {
          dy = speed;
          moveAngle = Math.PI / 2;
        } else if (player.lastMoveDir === 'left') {
          dx = -speed;
          moveAngle = Math.PI;
        } else if (player.lastMoveDir === 'right') {
          dx = speed;
          moveAngle = 0;
        }

        if (dx !== 0 || dy !== 0) {
          player.angle = moveAngle;
          const targetX = player.x + dx;
          const targetY = player.y + dy;

          const coll = checkTankCollision(targetX, targetY, room.grid);

          if (!coll.collision) {
            player.x = targetX;
            player.y = targetY;
          } else if (coll.type === 'water') {
            player.isDead = true;
            player.hp = 0;
            player.respawnTime = now + 3000;
            broadcast(room.id, 'player_destroyed', {
              victimId: player.id,
              victimName: player.name,
              killerName: 'Water Abyss',
              respawnTime: player.respawnTime
            });
          }
        }
      }
    }

    // Check power-up durations
    player.starActive = player.starUntil && now < player.starUntil;
    player.speedActive = player.speedUntil && now < player.speedUntil;
    player.fireActive = player.fireUntil && now < player.fireUntil;
    player.frozenActive = player.frozenUntil && now < player.frozenUntil;
  });

  // 4. Update Bullets
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const bullet = room.bullets[i];
    bullet.x += bullet.vx;
    bullet.y += bullet.vy;

    let destroyed = false;

    // Check map boundaries
    if (bullet.x < 0 || bullet.x > MAP_SIZE || bullet.y < 0 || bullet.y > MAP_SIZE) {
      destroyed = true;
    }

    // Check wall collisions (AABB)
    if (!destroyed) {
      const gx = Math.floor(bullet.x / TILE_SIZE);
      const gy = Math.floor(bullet.y / TILE_SIZE);

      if (gx >= 0 && gx < MAP_TILES && gy >= 0 && gy < MAP_TILES) {
        const tile = room.grid[gy][gx];
        if (tile === TILE_DESTRUCTIBLE) {
          destroyed = true;
          // Wall HP reduction
          const wallKey = `${gx},${gy}`;
          if (room.destructibleWalls[wallKey] === undefined) {
            room.destructibleWalls[wallKey] = 3;
          }
          room.destructibleWalls[wallKey]--;

          if (room.destructibleWalls[wallKey] <= 0) {
            room.grid[gy][gx] = TILE_EMPTY;
            delete room.destructibleWalls[wallKey];
            broadcast(room.id, 'map_update', { grid: room.grid, destructibleWalls: room.destructibleWalls });
          } else {
            broadcast(room.id, 'wall_damage', { gx, gy, hp: room.destructibleWalls[wallKey] });
          }
        } else if (tile === TILE_INDESTRUCTIBLE) {
          destroyed = true;
        }
      }
    }

    // Check Base collisions
    if (!destroyed) {
      const gx = Math.floor(bullet.x / TILE_SIZE);
      const gy = Math.floor(bullet.y / TILE_SIZE);

      for (const [teamName, base] of Object.entries(room.bases)) {
        if (base.hp > 0 && gx === base.x && gy === base.y) {
          destroyed = true;
          const shooter = room.players[bullet.ownerId];

          if (shooter) {
            if (bullet.team === teamName) {
              // Friendly fire on own base -> Block damage to avoid online griefing, but deduct points
              shooter.score = Math.max(0, shooter.score - 50);
              broadcast(room.id, 'team_score_update', room.teamsScore);
            } else {
              // Damage enemy base
              base.hp--;
              broadcast(room.id, 'base_hit', { team: teamName, hp: base.hp });

              if (base.hp <= 0) {
                // Base destroyed! Eliminate the team
                shooter.score += 500;
                room.teamsScore[shooter.team] += 500;
                eliminateTeam(room, teamName);
                broadcast(room.id, 'base_destroyed', { team: teamName, destroyedBy: shooter.name });
              }
            }
          }
          break;
        }
      }
    }

    // Check Player collisions
    if (!destroyed) {
      for (const player of Object.values(room.players)) {
        if (player.isDead) continue;

        // Bounding box distance test
        const dist = Math.hypot(bullet.x - player.x, bullet.y - player.y);
        if (dist < TANK_HALF + BULLET_SIZE / 2) {
          destroyed = true;
          const shooter = room.players[bullet.ownerId];

          if (player.starActive) {
            break; // Shielded
          }

          player.hp--;

          if (player.hp <= 0) {
            // Tank Destroyed
            player.isDead = true;
            player.respawnTime = now + 3000; // 3-second respawn timer

            if (shooter) {
              if (bullet.team === player.team) {
                // Friendly fire!
                shooter.score = Math.max(0, shooter.score - 50);
                room.teamsScore[shooter.team] = Math.max(0, room.teamsScore[shooter.team] - 50);
              } else {
                // Enemy kill
                shooter.score += 100;
                room.teamsScore[shooter.team] += 100;
              }
            }

            broadcast(room.id, 'player_destroyed', {
              victimId: player.id,
              victimName: player.name,
              killerName: shooter ? shooter.name : 'Abyss',
              respawnTime: player.respawnTime
            });
            broadcast(room.id, 'team_score_update', room.teamsScore);
          } else {
            // Hit but alive
            broadcast(room.id, 'player_hit', { playerId: player.id, hp: player.hp });
          }
          break;
        }
      }
    }

    if (destroyed) {
      const shooter = room.players[bullet.ownerId];
      if (shooter && shooter.activeBulletsCount > 0) {
        shooter.activeBulletsCount--;
      }
      room.bullets.splice(i, 1);
    }
  }

  // 5. Update Power-ups pickups
  for (let i = room.powerups.length - 1; i >= 0; i--) {
    const pu = room.powerups[i];

    for (const player of Object.values(room.players)) {
      if (player.isDead) continue;

      const dist = Math.hypot(player.x - pu.x, player.y - pu.y);
      if (dist < TANK_HALF + 15) {
        // Picked up!
        applyPowerup(room, player, pu.type);
        broadcast(room.id, 'powerup_collected', { playerId: player.id, type: pu.type, powerupId: pu.id });
        room.powerups.splice(i, 1);
        break;
      }
    }
  }

  // 6. Check Win conditions
  const activeTeams = Object.keys(TEAMS).filter(t => room.bases[t].hp > 0);
  if (activeTeams.length <= 1) {
    endGame(room, activeTeams[0] || null);
  }

  // Broadcast world state
  const stateUpdate = {
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      x: p.x,
      y: p.y,
      angle: p.angle,
      turretAngle: p.turretAngle,
      hp: p.hp,
      score: p.score,
      isDead: p.isDead,
      starActive: p.starActive,
      speedActive: p.speedActive,
      fireActive: p.fireActive,
      frozenActive: p.frozenActive,
      isBot: p.isBot || false,
      skin: p.skin || 'default',
      ammo: p.ammo !== undefined ? p.ammo : 6,
      reloadTimeLeft: p.reloadTimeLeft !== undefined ? p.reloadTimeLeft : 0
    })),
    bullets: room.bullets.map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, team: b.team })),
    powerups: room.powerups,
    bases: room.bases,
    timer: room.timer,
    teamsScore: room.teamsScore
  };

  broadcast(room.id, 'state_update', stateUpdate);
}

// Eliminate team (Base destroyed)
function eliminateTeam(room, teamName) {
  room.bases[teamName].hp = 0;

  // Set all players in that team as dead permanently or eliminate them
  Object.values(room.players).forEach(player => {
    if (player.team === teamName) {
      player.isDead = true;
      player.hp = 0;
      player.respawnTime = Infinity; // Will not respawn
      broadcast(room.id, 'player_eliminated', { playerId: player.id, name: player.name });
    }
  });
}

// Apply Power-up effects
function applyPowerup(room, player, type) {
  const now = Date.now();
  switch (type) {
    case 'star':
      player.starUntil = now + 5000; // 5s invulnerability
      break;

    case 'speed':
      player.speedUntil = now + 8000; // 8s double speed
      break;

    case 'fire':
      player.fireUntil = now + 10000; // 10s double fire
      break;

    case 'shield':
      const base = room.bases[player.team];
      if (base.hp > 0 && base.hp < 5) {
        base.hp++;
        broadcast(room.id, 'base_healed', { team: player.team, hp: base.hp });
      }
      break;

    case 'bomb':
      const px = Math.floor(player.x / TILE_SIZE);
      const py = Math.floor(player.y / TILE_SIZE);
      let wallDestroyed = false;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = px + dx;
          const gy = py + dy;
          if (gx >= 0 && gx < MAP_TILES && gy >= 0 && gy < MAP_TILES) {
            if (room.grid[gy][gx] === TILE_DESTRUCTIBLE) {
              room.grid[gy][gx] = TILE_EMPTY;
              delete room.destructibleWalls[`${gx},${gy}`];
              wallDestroyed = true;
            }
          }
        }
      }
      if (wallDestroyed) {
        broadcast(room.id, 'map_update', { grid: room.grid, destructibleWalls: room.destructibleWalls });
      }
      break;

    case 'freeze':
      Object.values(room.players).forEach(other => {
        if (other.team !== player.team) {
          other.frozenUntil = now + 3000;
        }
      });
      break;
  }
}

// End the Game
function endGame(room, winnerTeam = null) {
  room.state = 'GAMEOVER';
  clearInterval(room.gameInterval);

  if (!winnerTeam) {
    let maxScore = -1;
    let winningTeams = [];
    Object.entries(room.teamsScore).forEach(([team, score]) => {
      if (room.bases[team].hp > 0) {
        if (score > maxScore) {
          maxScore = score;
          winningTeams = [team];
        } else if (score === maxScore) {
          winningTeams.push(team);
        }
      }
    });
    winnerTeam = winningTeams[0] || null;
  }

  room.winnerTeam = winnerTeam;

  // Surviving players get +200 points
  Object.values(room.players).forEach(player => {
    if (!player.isDead && room.bases[player.team].hp > 0) {
      player.score += 200;
      room.teamsScore[player.team] += 200;
    }
  });

  broadcast(room.id, 'game_over', {
    winnerTeam,
    teamsScore: room.teamsScore,
    playerScores: Object.values(room.players).map(p => ({ name: p.name, team: p.team, score: p.score }))
  });
}

// Raw WebSockets Connection Handlers
let clientCount = 0;

wss.on('connection', (ws) => {
  const wsId = 'ws_' + (++clientCount) + '_' + Math.random().toString(36).substring(2, 6);
  let currentRoomId = null;
  let currentPlayerId = null;

  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message);
      const event = payload.event;
      const data = payload.data;

      if (event === 'join_room') {
        let { roomId, nickname, requestedTeam, mapType, duration, skin } = data;
        roomId = (roomId || 'default').trim();
        nickname = (nickname || 'Tanker').trim().substring(0, 12);
        
        if (!rooms[roomId]) {
          initRoom(roomId, mapType || 'city', duration || 300);
        }

        const room = rooms[roomId];

        if (room.state === 'GAMEOVER') {
          ws.send(JSON.stringify({
            event: 'error_message',
            data: 'Game has already ended in this room. Please create another room.'
          }));
          return;
        }

        // Limit room capacity to 8 players
        if (Object.keys(room.players).length >= 8) {
          ws.send(JSON.stringify({
            event: 'error_message',
            data: 'Room is full (maximum 8 players).'
          }));
          return;
        }

        currentRoomId = roomId;
        currentPlayerId = wsId;

        const team = assignTeam(room, requestedTeam);

        // Initialize player state
        room.players[wsId] = {
          id: wsId,
          name: nickname,
          team,
          isBot: false,
          skin: skin || 'default',
          x: TEAMS[team].spawn.x,
          y: TEAMS[team].spawn.y,
          angle: team === 'RED' || team === 'BLUE' ? Math.PI / 2 : -Math.PI / 2,
          turretAngle: team === 'RED' || team === 'BLUE' ? Math.PI / 2 : -Math.PI / 2,
          hp: 2,
          score: 0,
          isDead: false,
          activeBulletsCount: 0,
          lastShotTime: 0,
          disconnectTimeout: null,
          lastMoveDir: "",
          ammo: 6,
          reloadStartTime: null,
          reloadTimeLeft: 0,
          recentShots: []
        };

        room.playerSockets[wsId] = ws;

        // Send init_state back to player
        ws.send(JSON.stringify({
          event: 'init_state',
          data: {
            playerId: wsId,
            roomId,
            team,
            mapType: room.mapType,
            grid: room.grid,
            destructibleWalls: room.destructibleWalls,
            bases: room.bases,
            teamsScore: room.teamsScore,
            gameState: room.state
          }
        }));

        // Broadcast player joined to room
        broadcast(roomId, 'player_joined', {
          playerId: wsId,
          name: nickname,
          team
        });
      }

      else if (event === 'start_game') {
        const room = rooms[currentRoomId];
        if (room && room.state === 'LOBBY') {
          room.state = 'PLAYING';
          
          // Auto-fill empty teams with AI bots
          const activeTeams = {};
          Object.values(room.players).forEach(p => {
            activeTeams[p.team] = true;
          });

          Object.keys(TEAMS).forEach(team => {
            if (!activeTeams[team]) {
              const botId = `bot_${team}_${Math.random().toString(36).substring(2, 6)}`;
              room.players[botId] = {
                id: botId,
                name: `[BOT] ${team}`,
                team,
                isBot: true,
                skin: 'default',
                x: TEAMS[team].spawn.x,
                y: TEAMS[team].spawn.y,
                angle: team === 'RED' || team === 'BLUE' ? Math.PI / 2 : -Math.PI / 2,
                turretAngle: team === 'RED' || team === 'BLUE' ? Math.PI / 2 : -Math.PI / 2,
                hp: 2,
                score: 0,
                isDead: false,
                activeBulletsCount: 0,
                lastShotTime: 0,
                botDir: team === 'RED' || team === 'BLUE' ? 'down' : 'up',
                botChangeDirTimer: 0,
                botShootTimer: 0,
                ammo: 6,
                reloadStartTime: null,
                reloadTimeLeft: 0,
                recentShots: []
              };
            }
          });

          broadcast(currentRoomId, 'game_started', {});
          
          room.gameInterval = setInterval(() => {
            updateGame(room);
          }, 1000 / TICK_RATE);
        }
      }

      else if (event === 'move') {
        const room = rooms[currentRoomId];
        if (!room || room.state !== 'PLAYING') return;

        const player = room.players[currentPlayerId];
        if (!player || player.isDead || player.frozenActive) return;

        player.lastMoveDir = data.dir || "";
      }

      else if (event === 'aim') {
        const room = rooms[currentRoomId];
        if (!room || room.state !== 'PLAYING') return;

        const player = room.players[currentPlayerId];
        if (!player || player.isDead || player.frozenActive) return;

        player.turretAngle = data;
      }

      else if (event === 'shoot') {
        const room = rooms[currentRoomId];
        if (!room || room.state !== 'PLAYING') return;

        const player = room.players[currentPlayerId];
        if (!player || player.isDead || player.frozenActive) return;

        const now = Date.now();
        const maxActiveBullets = player.fireActive ? 2 : 1;
        if (player.activeBulletsCount >= maxActiveBullets) return;

        if (now - player.lastShotTime < 300) return;

        if (fireBullet(room, player)) {
          player.lastShotTime = now;
          player.activeBulletsCount++;
        }
      }

      else if (event === 'reconnect_player') {
        const { roomId, oldPlayerId } = data;
        const room = rooms[roomId];
        if (room && room.players[oldPlayerId]) {
          const player = room.players[oldPlayerId];
          clearTimeout(player.disconnectTimeout);

          room.players[wsId] = player;
          delete room.players[oldPlayerId];
          player.id = wsId;

          room.playerSockets[wsId] = ws;
          delete room.playerSockets[oldPlayerId];

          currentRoomId = roomId;
          currentPlayerId = wsId;

          ws.send(JSON.stringify({
            event: 'init_state',
            data: {
              playerId: wsId,
              roomId,
              team: player.team,
              mapType: room.mapType,
              grid: room.grid,
              destructibleWalls: room.destructibleWalls,
              bases: room.bases,
              teamsScore: room.teamsScore,
              gameState: room.state
            }
          }));

          broadcast(roomId, 'player_reconnected', { playerId: wsId, name: player.name });
        }
      }

    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoomId && currentPlayerId) {
      const room = rooms[currentRoomId];
      if (room && room.players[currentPlayerId]) {
        const player = room.players[currentPlayerId];
        broadcast(currentRoomId, 'player_disconnected', { playerId: currentPlayerId, name: player.name });

        player.disconnectTimeout = setTimeout(() => {
          if (room.players[currentPlayerId]) {
            room.bullets = room.bullets.filter(b => b.ownerId !== currentPlayerId);
            delete room.players[currentPlayerId];
            delete room.playerSockets[currentPlayerId];
            
            broadcast(currentRoomId, 'player_left', { playerId: currentPlayerId });

            const humansLeft = Object.values(room.players).filter(p => !p.isBot).length;
            if (humansLeft === 0) {
              clearInterval(room.gameInterval);
              delete rooms[currentRoomId];
            }
          }
        }, 10000);
      }
    }
  });
});

// Run server
server.listen(PORT, () => {
  console.log(`Tank Wars Server is running on port ${PORT}`);
});
