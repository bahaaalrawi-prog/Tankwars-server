extends Node

# Signals
signal connected
signal disconnected
signal error_occurred(message)
signal init_state_received(data)
signal state_updated(data)
signal map_updated(data)
signal player_joined(data)
signal player_left(data)
signal player_disconnected(data)
signal player_reconnected(data)
signal player_respawned(data)
signal player_destroyed(data)
signal player_hit(data)
signal base_hit(data)
signal base_destroyed(data)
signal powerup_collected(data)
signal bullet_fired(data)
signal game_over(data)
signal game_started
signal wall_damage(data)
# WebSocket connection variables
var socket: WebSocketPeer = WebSocketPeer.new()
var is_ws_connected: bool = false
var server_url: String = "wss://tankwars-server-production.up.railway.app"

var my_player_id: String = ""
var my_team: String = ""
var current_room_id: String = ""
var init_data: Dictionary = {}

func _ready():
	# By default, do not connect immediately, let Lobby handle it
	set_process(false)

func connect_to_server(url: String = "wss://tankwars-server-production.up.railway.app"):
	server_url = url
	socket = WebSocketPeer.new()
	var err = socket.connect_to_url(server_url)
	if err != OK:
		emit_signal("error_occurred", "Could not initiate connection: " + str(err))
		return
	
	is_ws_connected = false
	set_process(true)

func disconnect_from_server():
	socket.close()
	is_ws_connected = false
	set_process(false)

func _process(_delta):
	socket.poll()
	var state = socket.get_ready_state()
	
	if state == WebSocketPeer.STATE_OPEN:
		if not is_ws_connected:
			is_ws_connected = true
			emit_signal("connected")
		
		# Read incoming packets
		while socket.get_available_packet_count() > 0:
			var packet = socket.get_packet()
			var packet_str = packet.get_string_from_utf8()
			_handle_packet(packet_str)
			
	elif state == WebSocketPeer.STATE_CLOSED:
		if is_ws_connected:
			is_ws_connected = false
			emit_signal("disconnected")
			set_process(false)

# Send JSON payload helper
func send_event(event_name: String, data_payload: Variant):
	if socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	var payload = {
		"event": event_name,
		"data": data_payload
	}
	var json_str = JSON.stringify(payload)
	socket.send_text(json_str)

# Interface methods for Game code to call
func join_room(room_id: String, nickname: String, requested_team: String, map_type: String, duration: int, skin: String):
	var data = {
		"roomId": room_id,
		"nickname": nickname,
		"requestedTeam": requested_team,
		"mapType": map_type,
		"duration": duration,
		"skin": skin
	}
	send_event("join_room", data)

func start_game():
	send_event("start_game", {})

func send_move(direction: String):
	send_event("move", {"dir": direction})

func send_aim(angle: float):
	send_event("aim", angle)

func send_shoot():
	send_event("shoot", {})

func send_reconnect(room_id: String, old_player_id: String):
	send_event("reconnect_player", {
		"roomId": room_id,
		"oldPlayerId": old_player_id
	})

# Parse JSON strings and trigger signals
func _handle_packet(json_str: String):
	var json = JSON.new()
	var error = json.parse(json_str)
	if error != OK:
		print("Failed to parse JSON packet: ", json_str)
		return
		
	var payload = json.data
	if typeof(payload) != TYPE_DICTIONARY:
		return
		
	var event = payload.get("event", "")
	var data = payload.get("data", null)
	
	match event:
		"error_message":
			emit_signal("error_occurred", str(data))
		"init_state":
			init_data = data
			my_player_id = data.get("playerId", "")
			my_team = data.get("team", "")
			current_room_id = data.get("roomId", "")
			emit_signal("init_state_received", data)
		"player_joined":
			emit_signal("player_joined", data)
		"player_left":
			emit_signal("player_left", data)
		"player_disconnected":
			emit_signal("player_disconnected", data)
		"player_reconnected":
			emit_signal("player_reconnected", data)
		"game_started":
			emit_signal("game_started")
		"state_update":
			emit_signal("state_updated", data)
		"map_update":
			emit_signal("map_updated", data)
		"wall_damage":
			emit_signal("wall_damage", data)
		"player_destroyed":
			emit_signal("player_destroyed", data)
		"player_respawn":
			emit_signal("player_respawned", data)
		"player_hit":
			emit_signal("player_hit", data)
		"base_hit":
			emit_signal("base_hit", data)
		"base_destroyed":
			emit_signal("base_destroyed", data)
		"powerup_collected":
			emit_signal("powerup_collected", data)
		"bullet_fired":
			emit_signal("bullet_fired", data)
		"game_over":
			emit_signal("game_over", data)
