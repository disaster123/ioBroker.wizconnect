"use strict";

/*
 * Created with @iobroker/create-adapter v2.1.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const objectHelper = require('@apollon/iobroker-tools').objectHelper; // Common adapter utils
const EventEmitter = require('events').EventEmitter;
const uuid = require('uuid');

const ip = require("ip");
const os = require("os");

const AllDeviceAttributes = require('./lib/AllDeviceAttributes.js'); // Load attribute library
const ColorConv = require('./lib/colorconv.js'); // Load attribute library

const dgram = require('dgram');

// Load your modules here, e.g.:
// const fs = require("fs");

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

class Wizconnect extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	
	constructor(options) {
		super({
			...options,
			name: "wizconnect",
		});
		
		this.HOST = ip.address();//'0.0.0.0';
		this.PORTS = [38899, 38900];
		this.MAC = os.networkInterfaces()['eth0'][0]['mac'].replace(/:/g, '').toUpperCase(); //JSON.stringify(os.networkInterfaces());//
		this.IP = ip.address();
		this.SOCKETS = {};
		this.ISONLINE = {};
		this.MESSAGEQUEUE = {};
		this.maxAttempt = 10;
		this.sendTimeout = 1000;
		
		this.MESSAGEID = 1000;
		
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}
	
	async open_udp_sockets() {
		const that = this;
		for (const i in this.PORTS) {
			this.ISONLINE[this.PORTS[i]] = false;
			this.SOCKETS[this.PORTS[i]] = dgram.createSocket('udp4');
			this.SOCKETS[this.PORTS[i]].bind(this.PORTS[i], this.HOST);
			
			this.SOCKETS[this.PORTS[i]].on('error', (err) => {
				this.log.debug(`server error:\n${err.stack}`);
				this.ISONLINE[this.PORTS[i]] = false;
				this.SOCKETS[this.PORTS[i]].close();
			});
			
			this.SOCKETS[this.PORTS[i]].on('message', (msg, client) => {
				this.ISONLINE[this.PORTS[i]] = true;
				
				//this.log.debug(`server got: ${msg} from ${client.address}:${client.port}`);
				
				this.WIZ__RECEIVE_MESSAGE(msg, client);
			});
			
			this.SOCKETS[this.PORTS[i]].on('listening', () => {
				this.ISONLINE[this.PORTS[i]] = true;
			    const address = this.SOCKETS[this.PORTS[i]].address();
			    //this.log.debug(`server listening ${address.address}:${address.port}`);
			});
		}
	}
	
	WIZ__RECEIVE_MESSAGE(msg, client) {
		const that = this;
		// QUEUE löschen
		msg = JSON.parse(msg);
		if ('result' in msg) {
			if (client.address in this.MESSAGEQUEUE) {
				//this.log.debug(JSON.stringify(client));
				for (const queueID in this.MESSAGEQUEUE[client.address]) {
					let data = this.MESSAGEQUEUE[client.address][queueID];
					if (msg.method == data.message.method && client.port == data.port) {
						
						if (msg.method == 'getPilot' && ( msg.id == data.message.id || data.message.id == 0 ) ) {
							delete this.MESSAGEQUEUE[client.address][queueID];
							//this.log.debug(`[getPilot] ${client.address}:${client.port} success`);
							
							//msg.result = AllDeviceAttributes.override_with_null_not_exists()//Object.assign(AllDeviceAttributes.led_empty, msg.result);
							this.WIZ__UPDATE_STATES(client.address, msg.result);
							
						} else if (msg.method == 'setPilot' &&  msg.id == data.message.id && msg.result.success == true ) {
							delete this.MESSAGEQUEUE[client.address][queueID];
							//this.log.debug(`[setPilot] ${client.address}:${client.port} success`);
							
						} else if (msg.method == 'getSystemConfig' && msg.id == data.message.id && 'result' in msg ) {
							delete this.MESSAGEQUEUE[client.address][queueID];
							//this.log.debug(`[getSystemConfig] ${client.address}:${client.port} success`);
							this.WIZ__UPDATE_STATES(client.address, msg.result);
							
						} else if (msg.method == 'registration' && msg.id == data.message.id && 'result' in msg && msg.result.success == true ) {
							delete this.MESSAGEQUEUE[client.address][queueID];
							//this.log.debug(`[registration] ${client.address}:${client.port} success`);
							this.WIZ__UPDATE_STATES(client.address, {'ip':client.address});
							
						}
					}
				}
				
			} else {
				this.log.debug(`No QUEUE for Client ${client.address}:${client.port} found`);
			}
		} else if ('params' in msg && msg.method == 'syncPilot') {
			if (client.address in this.MESSAGEQUEUE) {
				client.port = 38899;
				//this.log.debug(`[syncPilot] ${client.address}:${client.port} received`);
				this.WIZ__UPDATE_STATES(client.address, msg.params);
				
				let message = new Buffer(`{"method":"syncPilot","result":{"mac":"${this.MAC}"}}`);
				//setTimeout(function() {
					that.SOCKETS[client.port].send(message, 0, message.length, client.port, client.address, (err) => {
						if (err) throw err;
					});
					//that.log.debug(`[syncPilot] ${client.address}:${client.port} answerd`);
				//}, 5000);
				
			}	
		}
	}
	
	async WIZ__UPDATE_STATES(ip, result){
		try {
			const deviceId = ip.replace(/\./g, '_');
			const convert = AllDeviceAttributes.conv_wiz_iob;
			
			result.online = true;
			result.ip = ip;
			
			for (const key in result) {
				if (key in convert) {
					//if (typeof await this.getObject(deviceId+'.'+convert[key]) !== undefined) {
					if (['hsv','hsl','rgb','drvConf'].includes(key)) {
						result[key] = JSON.stringify(result[key]);
					}
					if (key =='online') {
						this.setState(deviceId+'.'+convert[key], {val: result[key], ack: true, expire: this.config.listed_online});
					} else {
						this.setState(deviceId+'.'+convert[key], {val: result[key], ack: true});
					}
					
					//}
				}
			}
			
			//ToDo: Online expire
			
		} catch (err) {
			//this.log.debug(`__ERROR ->  ${FUNCTION_NAME} [ ${ip} : ${name} ]`);
			this.log.error(err);
		}
	}
	
	WIZ__QUEUE_MESSAGE(method, id, params, ip, port) {
		let queueID = uuid.v4();
		let data = {
			"ip": ip,
			"port": port,
			"attempt" : 0,
			"message": {
				"method": method,
				"id": id,
				"params": params
			},
			"message_buffer": ""
		}
		//if (data.message.id == 0 ) delete data.message.id;
		data['message_buffer'] = new Buffer(JSON.stringify(data.message));

		this.MESSAGEQUEUE[ip][queueID] = data;
		
		this.WIZ__SEND_MESSAGE(ip, queueID, this);
	}
	
	WIZ__SEND_MESSAGE(ip, queueID, that) {
		if (ip in that.MESSAGEQUEUE && queueID in that.MESSAGEQUEUE[ip] && that.MESSAGEQUEUE[ip][queueID]['attempt'] < that.maxAttempt) {
			that.MESSAGEQUEUE[ip][queueID]['attempt'] = ++that.MESSAGEQUEUE[ip][queueID]['attempt'];
			
			//that.log.debug(`Nachricht ${queueID} gesendet -> Versuch: ${that.MESSAGEQUEUE[ip][queueID]['attempt']}`);
			//that.log.warn(JSON.stringify(that.MESSAGEQUEUE[ip][queueID]['message']))
			
			that.SOCKETS[that.MESSAGEQUEUE[ip][queueID]['port']].send(that.MESSAGEQUEUE[ip][queueID]['message_buffer'], 0, that.MESSAGEQUEUE[ip][queueID]['message_buffer'].length, that.MESSAGEQUEUE[ip][queueID]['port'], ip, (err) => {
				if (err) throw err;
			});
			
			setTimeout(that.WIZ__SEND_MESSAGE, that.sendTimeout, ip, queueID, that);
		} else if (ip in that.MESSAGEQUEUE && queueID in that.MESSAGEQUEUE[ip] && that.MESSAGEQUEUE[ip][queueID]['attempt'] >= that.maxAttempt) {
			that.log.info(`Nachricht ${queueID} hat keine Antwort erhalten`);
			delete that.MESSAGEQUEUE[ip][queueID];
		}
	}
	
	WIZ__GET_MESSAGEID() {
		let messageID = this.MESSAGEID;
		this.MESSAGEID = this.MESSAGEID + 1;
		if (this.MESSAGEID > 9999) {
			this.MESSAGEID = 1000;
		}
		return messageID;
	}
	
	WIZ__REGISTER(client_ip) {
		let that = this;
		this.WIZ__QUEUE_MESSAGE('registration',that.WIZ__GET_MESSAGEID(),{"phoneMac":this.MAC,"phoneIp":this.IP,"register":true},client_ip, 38899);
	}
	
	WIZ__GETPILOT(client_ip) {
		this.WIZ__QUEUE_MESSAGE('getPilot',0,{},client_ip, 38899);
	}
	
	WIZ__SETPILOT(client_ip, params) {
		this.WIZ__QUEUE_MESSAGE('setPilot',this.WIZ__GET_MESSAGEID(),params,client_ip, 38899);  
	}
	
	WIZ__GETSYSTEMCONFIG(client_ip) {
		this.WIZ__QUEUE_MESSAGE('getSystemConfig',this.WIZ__GET_MESSAGEID(),{},client_ip, 38899);
	}
	
	WIZ__SET_STATE(client_ip, state) {
		this.WIZ__SETPILOT(client_ip,{'state':state});
	}
	
	WIZ__SET_DIMMING(client_ip, state) {
		this.WIZ__SETPILOT(client_ip,{'dimming':state});
	}
	
	WIZ__SET_COLORTEMP(client_ip, state) {
		this.log.warn('colortemp '+client_ip+' '+state);
		this.WIZ__UPDATE_STATES(client_ip, {'sceneid':0});
		this.WIZ__SETPILOT(client_ip,{'temp':state});	
	}
	
	async WIZ__SET_COLOR(client_ip) {
		let params = {}
		params.r = await this.WIZ__GET_IOB_STATE(client_ip,'led.r');
		params.g = await this.WIZ__GET_IOB_STATE(client_ip,'led.g');
		params.b = await this.WIZ__GET_IOB_STATE(client_ip,'led.b');
		params.w = await this.WIZ__GET_IOB_STATE(client_ip,'led.w');
		params.c = await this.WIZ__GET_IOB_STATE(client_ip,'led.c');
		
		for (let key in params) {
			if (params[key] == null ) {
				delete params[key];
			} else {
				params[key] = params[key]['val'];
			}
		}
		
		let rgb = [params.r, params.g, params.b];
		this.WIZ__SET_COLOR_RGB(client_ip, rgb);
		
		this.WIZ__UPDATE_STATES(client_ip, {'sceneid':0});
		this.WIZ__SETPILOT(client_ip,params);	
	}
	WIZ__SET_COLOR_HEX(client_ip, hex) {
		this.WIZ__SET_COLOR_RGB(client_ip,ColorConv.HEX2RGB(hex));
	}
	WIZ__SET_COLOR_HSL(client_ip, hsl) {
		if (!Array.isArray(hsl)) {
			hsl = JSON.parse(hsl);
		}
		this.WIZ__SET_COLOR_RGB(client_ip,ColorConv.HSL2RGB(hsl[0],hsl[1],hsl[2]));
	}
	WIZ__SET_COLOR_HSV(client_ip, hsv) {
		if (!Array.isArray(hsv)) {
			hsv = JSON.parse(hsv);
		}
		this.WIZ__SET_COLOR_RGB(client_ip,ColorConv.HSV2RGB(hsv[0],hsv[1],hsv[2]));
	}
	WIZ__SET_COLOR_HUE(client_ip, hue) {
		this.WIZ__SET_COLOR_RGB(client_ip,ColorConv.HUE2RGB(hue));
	}
	
	WIZ__SET_COLOR_RGB(client_ip, rgb) {
		if (!Array.isArray(rgb)) {
			rgb = JSON.parse(rgb);
		}
		let params = {'r':rgb[0],'g':rgb[1],'b':rgb[2]};
		let hsv = ColorConv.RGB2HSV(params.r, params.g, params.b);
		let hsl = ColorConv.RGB2HSL(params.r, params.g, params.b);
		let hex = ColorConv.RGB2HEX(params.r, params.g, params.b);
		let hue = ColorConv.RGB2HUE(params.r, params.g, params.b);
		
		this.WIZ__UPDATE_STATES(client_ip, {'sceneid':0,'rgb':rgb,'hsv':hsv,'hsl':hsl,'hex':hex,'hue':hue,'r':rgb[0],'g':rgb[1],'b':rgb[2],'c':0,'w':0});
		this.WIZ__SETPILOT(client_ip,params);	
	}
	
	WIZ__SET_SPEED(client_ip, state) {
		this.WIZ__SETPILOT(client_ip,{'speed':state});
	}
	
	WIZ__SET_SCENE(client_ip, state) {
		this.WIZ__SETPILOT(client_ip,{'sceneid':state});
	}
	
	
	async WIZ__GET_IOB_STATE(ip, key) {
		let client_ip = ip.replace(/\./g, '_');
		return await this.getStateAsync(client_ip+'.'+key);
		//return await this.getStateAsync(client_ip+'.'+key);
	}
	
	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		const that = this;
		// Initialize your adapter here
		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		//this.log.info("config option1: " + this.config.option1);
		//this.log.info("config option2: " + this.config.option2);
		//this.log.info(this.MAC);
		
		await this.open_udp_sockets();
		
		await this.WIZ__INIT_ALL_DEVICES()
		
		/*this.MESSAGEQUEUE['10.5.11.39'] = {};
		this.WIZ__QUEUE_MESSAGE('registration',133,{"phoneMac":this.MAC,"phoneIp":this.IP,"register":true},'10.5.11.39', 38899);
		
		this.WIZ__QUEUE_MESSAGE('getPilot',0,{},'10.5.11.39', 38899);
		
		this.WIZ__QUEUE_MESSAGE('setPilot',246,{"state":false},'10.5.11.39', 38899);  
		
		this.WIZ__QUEUE_MESSAGE('getSystemConfig',123,{},'10.5.11.39', 38899);*/
		
		
			

		/*
		// For every state in the system there has to be also an object of type state
		// Here a simple template for a boolean variable named "testVariable"
		// Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		
		await this.setObjectNotExistsAsync("testVariable", {
			type: "state",
			common: {
				name: "testVariable",
				type: "boolean",
				role: "indicator",
				read: true,
				write: true,
			},
			native: {},
		});

		// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		this.subscribeStates("testVariable");
		// You can also add a subscription for multiple states. The following line watches all states starting with "lights."
		// this.subscribeStates("lights.*");
		// Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
		// this.subscribeStates("*");

		
		//	setState examples
		//	you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		
		// the variable testVariable is set to true as command (ack=false)
		await this.setStateAsync("testVariable", true);

		// same thing, but the value is flagged "ack"
		// ack should be always set to true if the value is received from or acknowledged from the target system
		await this.setStateAsync("testVariable", { val: true, ack: true });

		// same thing, but the state is deleted after 30s (getState will return null afterwards)
		await this.setStateAsync("testVariable", { val: true, ack: true, expire: 30 });

		// examples for the checkPassword/checkGroup functions
		let result = await this.checkPasswordAsync("admin", "iobroker");
		this.log.info("check user admin pw iobroker: " + result);

		result = await this.checkGroupAsync("admin", "admin");
		this.log.info("check group user admin group admin: " + result);
		*/
		
		//this.setState("info.connection", true, false);
		this.setState('info.connection', true, true);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);
			for (const i in this.SOCKETS) {
				this.SOCKETS[i].close();
				this.ISONLINE[i] = false;
			}

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			if (state.ack == false) {
				let state_name = id.split('.').slice(-2).join('.');
				let client_ip = id.split('.').slice(2,3).join().replace(/_/g, '.');
				let state_value = state.val;
				eval(AllDeviceAttributes.get_on_function(state_name));
				//this.log.info(`state ${state_name} changed: ${state.val} (ack = ${state.ack}) ${JSON.stringify(state)}`);
			}			
		} else {
			// The state was deleted
			// ToDo: register again ????
			//this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }
	
	async WIZ__INIT_ALL_DEVICES() {
		let FUNCTION_NAME = 'WIZ__INIT_ALL_DEVICES';
		//this.log.debug(`_START -> ${FUNCTION_NAME}`);

		try {
			let devices = this.config.devices;
			let ip;
			let name;
			for (const k in devices) {
				if (devices[k].active == true) {
					ip = devices[k].ip;
					name = devices[k].name;
					await this.WIZ__INIT_DEVICE(ip, name); 
				}	
			}				
			
			let deviceStates = AllDeviceAttributes.defaults;
			if (deviceStates) {
				for (const statename in deviceStates) {
					const state = deviceStates[statename];
					if ('on' in state) {
						this.subscribeStates('*.'+statename);
					}
				}
			}
			//this.log.debug(`_END -> ${FUNCTION_NAME}`);
		} catch (err) {
			this.log.debug(`_ERROR -> ${FUNCTION_NAME}`);
			this.log.error(err);
		}
	}
	
	async WIZ__INIT_DEVICE(ip, name) {
		let FUNCTION_NAME = 'WIZ__INIT_DEVICES';
		let that = this;
		//this.log.debug(`__START ->  ${FUNCTION_NAME} [ ${ip} : ${name} ]`);

		try {
			const deviceId = ip.replace(/\./g, '_');
			this.MESSAGEQUEUE[ip] = {};
			//this.log.debug(`-> CREATE Device: ${deviceId}`);
			
			//let deviceStates = AllDeviceAttributes.defaults;
			let deviceStates = AllDeviceAttributes.MINIMAL();
			let deviceType = "MINIMAL";
			
			let obj = await this.getStateAsync(deviceId+'.system.moduleName');
			
			if (obj && obj.val.length > 5) {
				deviceType = obj.val;
				//this.log.warn(deviceType);
			}
			
			if (eval('typeof AllDeviceAttributes.'+deviceType+'() !== "undefined"')) {
				deviceStates = eval('AllDeviceAttributes.'+deviceType+'()');
			}
			
			if (deviceStates) {
				
				await this.extendObjectAsync( deviceId, {
					type: 'device',
					common: {
						name: `Device: ${name} - ${ip}`
					},
					native: {
						ip: ip,
						name: name,
						mac: '' // ToDo:
					}
				});
				
				for (const statename in deviceStates) {
					const state = deviceStates[statename];
					
					const channelId = statename.split('.').slice(0, 1).join();
									
					if (channelId !== statename) {
						
						//this.log.debug(`-> CREATE CHANNEL: ${deviceId}.${channelId}`);	
						await this.extendObjectAsync( deviceId + '.' + channelId, {
							type: 'channel',
							common: {
								name: `Channel: ${channelId}`
							},
							native: {}
						});
					} 
					
					//this.log.debug(`-> CREATE STATE: ${deviceId}.${statename}`);
					await this.extendObjectAsync( deviceId + '.' + statename, {
						type: 'state',
						common: state.common
					});
					
					
				}
			}
			
			let reg = await this.WIZ__GET_IOB_STATE(ip,'system.register');
			if (this.config.register_devices == true && reg !== null && reg.val == true ) { 
				this.WIZ__REGISTER(ip); 
			}
			this.WIZ__GETSYSTEMCONFIG(ip);
			this.WIZ__GETPILOT(ip);
			if (this.config.polling_intervall > 0) { 
				setInterval(this.WIZ__GETPILOT.bind(this), this.config.polling_intervall*1000, ip); 
			}
				
			//this.log.debug(`__END ->  ${FUNCTION_NAME} [ ${ip} : ${name} ]`);
		} catch (err) {
			this.log.debug(`__ERROR ->  ${FUNCTION_NAME} [ ${ip} : ${name} ]`);
			this.log.error(err);
		}
	}
	
	
	
	/*async create_state() {
	
		  let ip;
	
		  this.log.debug(`create state`);
		  let devices = this.config.devices;
		  try {
			for (const k in devices) {
				ip = devices[k].ip;
	
				if (devices[k].active) {
				  this.log.info ('Start with IP : ' + ip );
				  this.log.info (JSON. stringify(await this.wizLocalControl.getSystemConfig(devices[k].ip)));
				}
			}
	
			this.setState('info.connection', true, true);
			this.wizLocalControl.changeStatus(true, "192.168.0.95");
			//setTimeout(() => this.wizLocalControl.startListening(), 3000);	
		  } catch (err) {
			  this.log.debug(`create state problem`);
		  }
	}*/
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Wizconnect(options);
} else {
	// otherwise start the instance directly
	new Wizconnect();
}