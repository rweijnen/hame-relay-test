import * as mqtt from 'mqtt';
import {MqttClient} from 'mqtt';
import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';

import {calculateNewVersionTopicId} from './encryption';
import {HealthServer} from './health';
import {logger} from './logger';
import {HameApi, DeviceInfo} from './hame_api';

const deviceGenerations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 25, 50] as const;
type DeviceGen = typeof deviceGenerations[number];
const deviceTypes = ["A", "B", "D", "E", "F", "G", "J", "K", "I", "M", "N"] as const;
type DeviceType = typeof deviceTypes[number];
type DeviceTypeIdentifier = `HM${DeviceType}-${DeviceGen}` | `JPLS-8H`;
const knownDeviceTypes: DeviceTypeIdentifier[] = [
  ...(deviceGenerations.flatMap(gen => deviceTypes.map(type => `HM${type}-${gen}` satisfies DeviceTypeIdentifier))),
  "JPLS-8H",
];

interface Device {
  device_id: string;
  mac: string;
  type: DeviceTypeIdentifier;
  version?: number;
  inverse_forwarding?: boolean;
  name?: string;
  broker_id?: string;
  remote_id?: string;
  use_remote_topic_id?: boolean;
}

interface BrokerDefinition {
  url: string;
  ca: string;
  cert: string;
  key: string;
  topic_prefix?: string;
  xid1_topic_prefix?: string;
  local_topic_prefix?: string;
  topic_encryption_key?: string;
  client_id_prefix?: string;
  use_remote_topic_id_versions?: Record<string, number[]>;
  min_versions?: Record<string, number>;
}

interface ForwarderConfig {
  broker_url: string;
  devices: Device[];
  inverse_forwarding?: boolean;
  username?: string;
  password?: string;
  remote: BrokerDefinition;
  broker_id: string;
}

interface MainConfig {
  broker_url: string;
  devices: Device[];
  inverse_forwarding?: boolean;
  username?: string;
  password?: string;
  default_broker_id?: string;
}



/**
 * Processes broker properties to handle file path references (prefixed with @)
 * @param brokers The brokers configuration object
 * @param brokersConfigPath The path to the brokers configuration file
 * @returns The processed brokers configuration with file contents loaded
 */
function processBrokerProperties(brokers: Record<string, BrokerDefinition>, brokersConfigPath: string): Record<string, BrokerDefinition> {
  const processedBrokers: Record<string, BrokerDefinition> = {};
  const configDir = dirname(brokersConfigPath);
  
  for (const [brokerId, broker] of Object.entries(brokers)) {
    const processedBroker: BrokerDefinition = { ...broker };
    
    for (const prop of Object.keys(processedBroker)) {
      const key = prop as keyof BrokerDefinition;
      const value = processedBroker[key];
      if (typeof value === 'string' && value.startsWith('@')) {
        const filePath = value.substring(1);
        try {
          const absolutePath = join(configDir, filePath);
          (processedBroker as any)[key] = readFileSync(absolutePath, 'utf8').trim();
          logger.debug(`Loaded ${prop} from file: ${absolutePath}`);
        } catch (error) {
          logger.error(error, `Failed to load ${prop} from file ${filePath} for broker ${brokerId}`);
          throw error;
        }
      }
    }
    
    processedBrokers[brokerId] = processedBroker;
  }
  
  return processedBrokers;
}


function autoDetermineBroker(device: Device, brokers: Record<string, BrokerDefinition>): string | undefined {
  if (device.version == null) {
    return undefined;
  }
  const regex = /(.*)-[\d\w]+/;
  const match = regex.exec(device.type);
  if (!match) {
    return undefined;
  }
  const baseType = match[1];
  let chosen: string | undefined;
  let highest = -Infinity;
  for (const [id, broker] of Object.entries(brokers)) {
    const minVersions = broker.min_versions;
    if (minVersions && Object.prototype.hasOwnProperty.call(minVersions, baseType)) {
      const min = minVersions[baseType];
      if (device.version >= min && min > highest) {
        chosen = id;
        highest = min;
      }
    }
  }
  return chosen;
}

function shouldUseRemoteTopicId(device: Device, broker: BrokerDefinition): boolean {
  if (device.version == null) {
    return false;
  }
  const regex = /(.*)-[\d\w]+/;
  const match = regex.exec(device.type);
  if (!match) {
    return false;
  }
  const baseType = match[1];
  const mapping = broker.use_remote_topic_id_versions;
  if (!mapping || !Object.prototype.hasOwnProperty.call(mapping, baseType)) {
    return false;
  }
  const versions = mapping[baseType];
  return versions.includes(device.version);
}

function cleanAndValidate(config: {devices: Device[]}): void {
  logger.debug(`Validating ${config.devices.length} devices...`);
  logger.debug(`Found ${config.devices.length} devices in config file`);
  if (config.devices.length === 0) {
    throw new Error('No devices specified in config file');
  }
  const remainingDevices = [];
  const errors = [];
  for (const device of config.devices) {
    logger.debug(`Validating device: ${device.device_id}`);
    try {
      if (!device.device_id) {
        throw new Error('Device ID is required');
      }
      if (!device.mac) {
        throw new Error('MAC address is required');
      }
      if (!device.type) {
        throw new Error('Device type is required');
      }
      device.device_id = device.device_id.trim();
      // Remove colons from MAC address and convert to lowercase
      device.mac = device.mac.trim().replace(/:/g, '').toLowerCase();
      device.type = device.type.trim().toUpperCase() as DeviceTypeIdentifier;
      if (device.device_id.length !== 12 && (device.device_id.length < 22 || device.device_id.length > 24)) {
        throw new Error('Device ID must be between 22 and 24 or exactly 12 characters long');
      }
      if (!/^[0-9A-Fa-f]{12}$/.test(device.mac)) {
        throw new Error('MAC address must be a 12-character hexadecimal string');
      }
      if (device.type && !knownDeviceTypes.includes(device.type)) {
        logger.warn(`Unknown device type: ${device.type}. This device will likely not be forwarded.`);
      }
      remainingDevices.push(device);
    } catch (error) {
      errors.push(`Device ${device.device_id}: ${(error as Error).message}`);
    }
  }
  config.devices = remainingDevices;

  if (errors.length > 0) {
    logger.debug(`Found ${errors.length} errors in devices`);
    if (config.devices.length === 0) {
      throw new Error(`All devices failed validation:\n${errors.join('\n')}`);
    } else {
      logger.warn(`Some devices failed validation:\n${errors.join('\n')}`);
    }
  }
}

class MQTTForwarder {
  private configBroker!: mqtt.MqttClient;
  private remoteBroker!: mqtt.MqttClient;
  private readonly logger: typeof logger;
  private readonly MESSAGE_HISTORY_TIMEOUT = 1000; // 1 second timeout
  private readonly RATE_LIMIT_INTERVAL = 59900; // Rate limit interval in milliseconds
  private readonly MESSAGE_CACHE_TIMEOUT = 1000; // 1 second timeout for message loop prevention
  private readonly INSTANCE_ID = createHash('md5').update(`${Date.now()}-${Math.random()}`).digest('hex').substring(0, 8); // Unique ID for this instance
  private appMessageHistory: Map<string, number> = new Map(); // Store when App messages were forwarded
  private rateLimitedMessages: Map<string, number> = new Map(); // Store when rate-limited messages were last forwarded
  private processedMessages: Map<string, number> = new Map(); // Store message hashes to prevent loops
  private readonly RATE_LIMITED_CODES = [1, 13, 15, 16, 21, 26, 28, 30]; // Message codes to rate-limit (as numbers)

  constructor(private readonly config: ForwarderConfig) {
    this.logger = logger.child({}, {
        msgPrefix: `[${config.broker_id}] `,
      }
    );
    this.initializeBrokers();
  }

  public getRemoteBroker(): MqttClient {
    return this.remoteBroker;
  }

  public getConfigBroker(): MqttClient {
    return this.configBroker;
  }

  /**
   * Checks if a message should be rate-limited based on its content
   * @param message The message buffer to check
   * @param deviceKey The unique device key
   * @returns true if the message should be rate-limited, false otherwise
   */
  private shouldRateLimit(message: Buffer, deviceKey: string): boolean {
    try {
      const messageStr = message.toString();
      
      // Extract the code number from the message
      const codeMatch = messageStr.match(/cd=0*(\d+)/);
      if (!codeMatch) {
        return false;
      }
      
      // Convert the extracted code to a number
      const messageCodeNum = parseInt(codeMatch[1], 10);
      
      // Check if the code is in our rate-limited list
      if (!this.RATE_LIMITED_CODES.includes(messageCodeNum)) {
        return false;
      }
      
      // Create a unique key for this device and message type
      const rateLimitKey = `${deviceKey}:${messageCodeNum}`;
      
      // Check if we've seen this message recently
      const lastSentTime = this.rateLimitedMessages.get(rateLimitKey);
      const currentTime = Date.now();
      
      if (lastSentTime && (currentTime - lastSentTime < this.RATE_LIMIT_INTERVAL)) {
        const remainingTime = this.RATE_LIMIT_INTERVAL - (currentTime - lastSentTime);
        this.logger.info(`Devices configured with inverse_forwarding get rate limited. Rate limiting message with code cd=${messageCodeNum} for device ${deviceKey}. Please wait for ${remainingTime}ms before sending another message. Use inverse_forwarding=false to avoid rate limiting.`);
        return true;
      }
      
      // Update the last sent time for this message type
      this.rateLimitedMessages.set(rateLimitKey, currentTime);
      return false;
    } catch (error) {
      this.logger.error(error, 'Error in rate limiting logic');
      return false; // On error, don't rate limit
    }
  }

  private loadCertificates(): { ca: Buffer; cert: Buffer; key: Buffer } {
    try {
      return {
        ca: Buffer.from(this.config.remote.ca, 'utf8'),
        cert: Buffer.from(this.config.remote.cert, 'utf8'),
        key: Buffer.from(this.config.remote.key, 'utf8')
      };
    } catch (error: unknown) {
      this.logger.error(error, 'Failed to load certificates');
      throw error;
    }
  }

  private initializeBrokers(): void {
    const configOptions = {
      keepalive: 30,
      clientId: this.generateClientId('config_')
    };
    this.configBroker = mqtt.connect(this.config.broker_url, configOptions);

    const certs = this.loadCertificates();
    const remoteOptions = {
      ...certs,
      protocol: 'mqtts' as const,
      keepalive: 30,
      clientId: this.generateClientId(this.config.remote.client_id_prefix || 'hm_')
    };
    this.remoteBroker = mqtt.connect(this.config.remote.url, remoteOptions);

    this.setupBrokerEventHandlers();
  }

  private generateClientId(prefix: string): string {
    let randomClientId = '';
    for (let i = 0; i < 24; i++) {
      randomClientId += Math.floor(Math.random() * 16).toString(16);
    }
    return `${prefix}${randomClientId}`;
  }

  private setupBrokerEventHandlers(): void {
    // Config broker event handlers
    this.configBroker.on('connect', () => {
      this.logger.info('Connected to config broker');
    });
    this.setupConfigSubscriptions();

    // Set up error handlers
    this.configBroker.on('error', (error: Error) => {
      this.logger.error(error, 'Config broker error');
    });

    this.configBroker.on('disconnect', () => {
      this.logger.warn('Config broker disconnected');
    });

    this.configBroker.on('offline', () => {
      this.logger.warn('Config broker went offline');
    });

    // Remote broker event handlers
    this.remoteBroker.on('connect', () => {
      this.logger.info('Connected to remote broker');
    });
    this.setupRemoteSubscriptions();

    this.remoteBroker.on('error', (error: Error) => {
      this.logger.error(error, 'Remote broker error');
    });

    this.remoteBroker.on('disconnect', () => {
      this.logger.warn('Remote broker disconnected');
    });

    this.remoteBroker.on('offline', () => {
      this.logger.warn('Remote broker went offline');
    });
  }

  private setupConfigSubscriptions(): void {
    this.setupSubscriptions(this.configBroker);
  }

  private setupRemoteSubscriptions(): void {
    this.setupSubscriptions(this.remoteBroker);
  }

  /**
   * Detects XID format from topic structure
   * @param topic The MQTT topic string
   * @returns 'xid0' for marstek_energy format, 'xid1' for marstek format, or null if unrecognized
   */
  private detectXIDFormat(topic: string): 'xid0' | 'xid1' | null {
    if (topic.includes('marstek_energy/')) {
      return 'xid0';
    } else if (topic.startsWith('marstek/') && topic.includes('/server/')) {
      return 'xid1';
    } else if (topic.startsWith('marstek/') && topic.includes('/device/')) {
      return 'xid1';
    }
    return null;
  }

  /**
   * Converts topic from one XID format to another
   * @param topic Original topic
   * @param fromFormat Source format
   * @param toFormat Target format
   * @param deviceType Device type (e.g., 'HMA')
   * @param identifier Device identifier
   * @returns Converted topic or original if conversion not possible
   */
  private convertTopicFormat(topic: string, fromFormat: 'xid0' | 'xid1', toFormat: 'xid0' | 'xid1', deviceType: string, identifier: string): string {
    if (fromFormat === toFormat) return topic;
    
    if (fromFormat === 'xid0' && toFormat === 'xid1') {
      // marstek_energy/{type}/App/{id}/ctrl -> marstek/{type}/server/{id}/ctrl
      if (topic.includes('/App/') && topic.endsWith('/ctrl')) {
        const xid1Prefix = this.config.remote.xid1_topic_prefix || 'marstek/';
        return `${xid1Prefix}${deviceType}/server/${identifier}/ctrl`;
      }
    } else if (fromFormat === 'xid1' && toFormat === 'xid0') {
      // marstek/{type}/server/{id}/ctrl -> marstek_energy/{type}/App/{id}/ctrl  
      if (topic.includes('/server/') && topic.endsWith('/ctrl')) {
        const xid0Prefix = this.config.remote.topic_prefix || 'marstek_energy/';
        return `${xid0Prefix}${deviceType}/App/${identifier}/ctrl`;
      }
    }
    
    return topic;
  }

  /**
   * Determines the appropriate topic prefix and identifier for a device on a specific broker
   * 
   * This centralized method handles all the logic for determining which topic structure to use:
   * 
   * For LOCAL broker (configBroker):
   *   - If use_remote_topic_id=true: Uses remote structure (topic_prefix + remote_id)
   *   - If use_remote_topic_id=false: Uses local structure (local_topic_prefix + mac)
   * 
   * For REMOTE broker (remoteBroker):
   *   - Always uses remote structure (topic_prefix + remote_id)
   * 
   * @param device The device configuration
   * @param broker The MQTT broker (configBroker for local, remoteBroker for remote)
   * @returns Object containing prefix and identifier to use for this device on this broker
   */
  private getTopicStructureForDevice(device: Device, broker: MqttClient): { prefix: string; identifier: string } {
    if (broker === this.configBroker) {
      // Local broker
      if (device.use_remote_topic_id) {
        // Use remote topic structure on local broker
        return {
          prefix: this.config.remote.topic_prefix || 'hame_energy/',
          identifier: device.remote_id!
        };
      } else {
        // Use local topic structure
        return {
          prefix: this.config.remote.local_topic_prefix || this.config.remote.topic_prefix || 'hame_energy/',
          identifier: device.mac
        };
      }
    } else {
      // Remote broker - always use remote structure
      return {
        prefix: this.config.remote.topic_prefix || 'hame_energy/',
        identifier: device.remote_id!
      };
    }
  }

  private setupSubscriptions(broker: MqttClient): void {
    const brokerName = broker === this.configBroker ? 'local' : 'remote';
    
    // Subscribe to both XID0 and XID1 topic formats for dual compatibility
    const topics: string[] = [];
    
    this.config.devices.forEach(device => {
      // Get the appropriate topic structure for this device on this broker
      const { prefix, identifier } = this.getTopicStructureForDevice(device, broker);
      
      let inverseForwarding = device.inverse_forwarding ?? this.config.inverse_forwarding;
      if (broker === this.configBroker) {
        inverseForwarding = !inverseForwarding;
      }
      
      // XID0 format (existing)
      const xid0Topic = inverseForwarding ?
          `${prefix}${device.type}/device/${identifier}/ctrl` :
          `${prefix}${device.type}/App/${identifier}/ctrl`;
      topics.push(xid0Topic);
      
      // XID1 format (new) - only for remote broker
      if (broker === this.remoteBroker) {
        const xid1Prefix = this.config.remote.xid1_topic_prefix || 'marstek/';
        const xid1Topic = inverseForwarding ?
            `${xid1Prefix}${device.type}/device/${identifier}/ctrl` :
            `${xid1Prefix}${device.type}/server/${identifier}/ctrl`;
        topics.push(xid1Topic);
      }
    });
    
    // Remove duplicates
    const uniqueTopics = [...new Set(topics)];
    
    this.logger.debug(`Subscribing to ${brokerName} broker topics (dual XID format):\n${uniqueTopics.join("\n")}`);
    broker.subscribe(uniqueTopics, (err: Error | null) => {
      if (err) {
        this.logger.error(err, `Error subscribing to ${brokerName} broker for device`);
        return;
      }
      this.logger.info(`Subscribed to ${brokerName} broker topics (${uniqueTopics.length} topics)`);
    });

    broker.on('message', (topic: string, message: Buffer, packet: mqtt.IPublishPacket) => {
      this.forwardMessage(topic, message, broker === this.configBroker ? this.remoteBroker : this.configBroker, packet);
    });
  }

  /**
   * Checks if a message has been processed by this or another relay instance
   * @param packet The MQTT packet containing message and properties
   * @returns true if the message has been processed and should be skipped, false otherwise
   */
  private isMessageProcessed(packet: mqtt.IPublishPacket): boolean {
    try {
      // Check if this message has a relay header
      if (packet.properties && packet.properties.userProperties) {
        const userProps = packet.properties.userProperties;
        
        // Check if this message has our relay instance ID or another relay's
        if (typeof userProps.relayInstanceId === "string") {
          // Message has already been processed by a relay
          if (userProps.relayInstanceId === this.INSTANCE_ID) {
            // This is our own message coming back - definitely skip it
            this.logger.debug('Skipping message from our own relay instance');
            return true;
          } else {
            // Message from another relay instance - also skip it to prevent loops
            this.logger.debug(`Skipping message from relay instance: ${userProps.relayInstanceId.substring(0, 8)}`);
            return true;
          }
        }
      }
      return false;
    } catch (error) {
      this.logger.error(error, 'Error checking if message is processed');
      return false; // On error, don't skip the message
    }
  }
  
  private forwardMessage(topic: string, message: Buffer, targetClient: MqttClient, packet?: mqtt.IPublishPacket): void {
    // Check if this is a looped message that should be skipped
    if (packet && this.isMessageProcessed(packet)) {
      return;
    }

    // Try to match the topic and find the corresponding device
    let matchedDevice: Device | undefined;
    let topicType = '';
    let isDevice = false;

    // Try to match against all possible topic patterns for all devices (XID0 and XID1)
    let sourceXIDFormat: 'xid0' | 'xid1' | null = null;
    
    for (const device of this.config.devices) {
      const sourceClient = targetClient === this.configBroker ? this.remoteBroker : this.configBroker;
      
      // Get the expected topic structure for this device on the source broker
      const { prefix: expectedPrefix, identifier: expectedIdentifier } = this.getTopicStructureForDevice(device, sourceClient);
      
      // Try XID0 format first (existing pattern)
      const xid0Pattern = new RegExp(`^${expectedPrefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^/]+)/(device|App)/(.*)/ctrl$`);
      let matches = topic.match(xid0Pattern);
      
      if (matches && matches[1] === device.type && matches[3] === expectedIdentifier) {
        matchedDevice = device;
        topicType = matches[1];
        isDevice = matches[2] === 'device';
        sourceXIDFormat = 'xid0';
        break;
      }
      
      // Try XID1 format (marstek/{type}/server/{id}/ctrl or marstek/{type}/device/{id}/ctrl)
      if (sourceClient === this.remoteBroker) {
        const xid1Prefix = this.config.remote.xid1_topic_prefix || 'marstek/';
        const xid1Pattern = new RegExp(`^${xid1Prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^/]+)/(server|device)/(.*)/ctrl$`);
        matches = topic.match(xid1Pattern);
        
        if (matches && matches[1] === device.type && matches[3] === expectedIdentifier) {
          matchedDevice = device;
          topicType = matches[1];
          // In XID1: 'device' = device message, 'server' = App/server message (equivalent to App in XID0)
          isDevice = matches[2] === 'device';
          sourceXIDFormat = 'xid1';
          break;
        }
      }
    }

    if (!matchedDevice) {
      this.logger.warn(`No matching device found for topic: ${topic}`);
      return;
    }
    this.logger.debug(`Matched device: ${matchedDevice?.device_id}`);

    const inverseForwarding = matchedDevice.inverse_forwarding ?? this.config.inverse_forwarding;
    this.logger.debug(`Inverse forwarding: ${inverseForwarding}`);
    
    // Create a unique key for this device
    const deviceKey = `${matchedDevice.type}:${matchedDevice.device_id}:${matchedDevice.mac}`;
    
    if (targetClient === this.configBroker) {
      if (isDevice && !inverseForwarding) {
        this.logger.warn(`Ignoring remote device message for device without inverse forwarding: ${topic}`);
        return;
      } else if (!isDevice && inverseForwarding) {
        this.logger.warn(`Ignoring remote App message for device with direct forwarding: ${topic}`);
        return;
      }
    } else {
      if (isDevice && inverseForwarding) {
        this.logger.warn(`Ignoring local device message for device with inverse forwarding: ${topic}`);
        return;
      } else if (!isDevice && !inverseForwarding) {
        this.logger.warn(`Ignoring local App message for device without direct forwarding: ${topic}`);
        return;
      }
    }

    if (isDevice) {
      // Check if we previously forwarded an App message for this device
      const lastAppMessageTime = this.appMessageHistory.get(deviceKey);
      const currentTime = Date.now();

      if (!lastAppMessageTime || (currentTime - lastAppMessageTime > this.MESSAGE_HISTORY_TIMEOUT)) {
        this.logger.debug(`Skipping device message forwarding to remote for ${deviceKey}: no recent App message was forwarded`);
        return;
      }
      this.appMessageHistory.delete(deviceKey);
    } else {
      // This is an App message, record it in history
      this.appMessageHistory.set(deviceKey, Date.now());

      // Apply rate limiting for messages going from local to Hame
      if (targetClient === this.remoteBroker && this.shouldRateLimit(message, deviceKey)) {
        return;
      }
    }
    
    // Get the target topic structure for this device on the target broker
    const { prefix: targetPrefix, identifier: targetIdentifier } = this.getTopicStructureForDevice(matchedDevice, targetClient);
    this.logger.debug(`Target prefix: ${targetPrefix}`);
    this.logger.debug(`Target identifier: ${targetIdentifier}`);
    
    // Determine target XID format and build appropriate topic
    let newTopic: string;
    let targetXIDFormat: 'xid0' | 'xid1';
    
    // Determine target format based on target broker and source format
    if (targetClient === this.configBroker) {
      // Going to local broker - always use XID0 format
      targetXIDFormat = 'xid0';
      const deviceOrApp = isDevice ? 'device' : 'App';
      newTopic = `${targetPrefix}${topicType}/${deviceOrApp}/${targetIdentifier}/ctrl`;
    } else {
      // Going to remote broker - maintain source format or use XID0 as default
      if (sourceXIDFormat === 'xid1') {
        // Keep XID1 format for remote
        targetXIDFormat = 'xid1';
        const xid1Prefix = this.config.remote.xid1_topic_prefix || 'marstek/';
        // For XID1: device messages go to server topics, server messages go to device topics
        const xid1Part = isDevice ? 'device' : 'server';
        newTopic = `${xid1Prefix}${topicType}/${xid1Part}/${targetIdentifier}/ctrl`;
      } else {
        // Use XID0 format for remote (legacy)
        targetXIDFormat = 'xid0';
        const deviceOrApp = isDevice ? 'device' : 'App';
        newTopic = `${targetPrefix}${topicType}/${deviceOrApp}/${targetIdentifier}/ctrl`;
      }
    }
    
    this.logger.debug(`XID format conversion: ${sourceXIDFormat} -> ${targetXIDFormat}`);
    this.logger.debug(`New topic: ${newTopic}`);
    const from = targetClient === this.configBroker ? 'remote' : 'local';
    const to = targetClient === this.configBroker ? 'local' : 'remote';
    this.logger.debug(`From: ${from}`);
    this.logger.debug(`To: ${to}`);
    
    // Add relay instance header to the message to prevent loops
    const publishOptions = {
      properties: {
        userProperties: {
          relayInstanceId: this.INSTANCE_ID
        }
      }
    };
    
    targetClient.publish(newTopic, message, publishOptions);
    this.logger.info(`Forwarded message from ${from} to ${to}: ${topic} -> ${newTopic}`);
  }

  public close(): void {
    this.configBroker.end();
    this.remoteBroker.end();
  }
  
  // Clean up old message history entries periodically
  private cleanupMessageHistory(): void {
    const now = Date.now();
    // Clean up app message history
    for (const [key, timestamp] of this.appMessageHistory.entries()) {
      if (now - timestamp > this.MESSAGE_HISTORY_TIMEOUT * 2) {
        this.appMessageHistory.delete(key);
      }
    }
    
    // Clean up rate-limited message history
    for (const [key, timestamp] of this.rateLimitedMessages.entries()) {
      if (now - timestamp > this.RATE_LIMIT_INTERVAL * 2) {
        this.rateLimitedMessages.delete(key);
      }
    }
    
    // Clean up processed messages cache
    for (const [key, timestamp] of this.processedMessages.entries()) {
      if (now - timestamp > this.MESSAGE_CACHE_TIMEOUT * 2) {
        this.processedMessages.delete(key);
      }
    }
  }
}

async function start() {
  try {
    const configPath = process.env.CONFIG_PATH || './config/config.json';
    const brokersPath = process.env.BROKERS_PATH || './brokers.json';
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as MainConfig;
    let brokers: Record<string, BrokerDefinition>;
    try {
      const rawBrokers = JSON.parse(readFileSync(brokersPath, 'utf8')) as Record<string, BrokerDefinition>;
      brokers = processBrokerProperties(rawBrokers, brokersPath);
    } catch (err) {
      logger.error(err, `Failed to load brokers config at ${brokersPath}`);
      throw err;
    }

    // Initialize devices array if it doesn't exist
    if (!config.devices) {
      config.devices = [];
    }

    // Create a map of user-configured devices for quick lookup and merging
    const userDevicesMap = new Map<string, Device>();
    config.devices.forEach(device => {
      if (device.device_id) {
        userDevicesMap.set(device.device_id, device);
      }
    });
    
    // If username and password are provided, fetch device information from API
    if (config.username && config.password) {
      try {
        logger.info('Credentials found in config, attempting to fetch devices from API...');
        const api = new HameApi();
        const apiDevicesRaw: DeviceInfo[] = await api.fetchDevices(config.username, config.password);
        const apiDevices: Device[] = apiDevicesRaw.map(device => {
          let deviceType = device.type as DeviceTypeIdentifier;
          if (!knownDeviceTypes.includes(deviceType)) {
            logger.warn(`Unknown device type from API: ${device.type}. Using as-is.`);
          }
          const v = parseInt(device.version, 10);
          return {
            device_id: device.devid,
            mac: device.mac,
            type: deviceType,
            name: device.name,
            version: isNaN(v) ? undefined : v,
          } as Device;
        });
        
        if (apiDevices.length > 0) {
          logger.info(`Retrieved ${apiDevices.length} devices from API`);
          
          // Process each API device
          for (const apiDevice of apiDevices) {
            if (userDevicesMap.has(apiDevice.device_id)) {
              // Device already exists in user config - merge only missing information
              const userDevice = userDevicesMap.get(apiDevice.device_id)!;
              
              // Only update fields if they're missing in user config
              if (!userDevice.type) {
                userDevice.type = apiDevice.type;
              }
              if (!userDevice.name) {
                userDevice.name = apiDevice.name;
              }
              if (!userDevice.mac) {
                userDevice.mac = apiDevice.mac;
              }
              if (userDevice.version == null) {
                userDevice.version = apiDevice.version;
              }
            } else {
              // New device from API - add to config
              config.devices.push(apiDevice);
              userDevicesMap.set(apiDevice.device_id, apiDevice);
            }
          }
          
          logger.info(`Config now contains ${config.devices.length} devices (${userDevicesMap.size} unique)`);
        }
      } catch (apiError) {
        logger.error(apiError, 'Failed to fetch devices from API');
        logger.warn('Continuing with devices from config file only');
      }
    }

    // Auto determine broker for devices when version information is available
    for (const device of config.devices) {
      if (!device.broker_id) {
        const auto = autoDetermineBroker(device, brokers);
        if (auto) {
          device.broker_id = auto;
          logger.info(`Auto-selected broker ${auto} for device ${device.device_id}`);
        }
      }
    }

    cleanAndValidate(config);

    const defaultId = config.default_broker_id || 'hame-2024';
    logger.debug(`Using default broker ID: ${defaultId}`);
    const devicesByBroker: Record<string, Device[]> = {};
    for (const device of config.devices) {
      const brokerId = device.broker_id || defaultId;
      logger.debug(`Using broker ID: ${brokerId} for device ${device.device_id}`);
      const broker = brokers[brokerId];
      if (!broker) {
        throw new Error(`Broker '${brokerId}' not defined`);
      }
      device.broker_id = brokerId;
      if (!device.remote_id) {
        if (broker.topic_encryption_key) {
          logger.debug(`Using topic encryption key for device ${device.device_id}`);
          device.remote_id = calculateNewVersionTopicId(Buffer.from(broker.topic_encryption_key, 'hex'), device.mac);
          logger.debug(`Calculated remote ID: ${device.remote_id} for device ${device.device_id}`);
        } else {
          logger.debug(`No topic encryption key found for device ${device.device_id}, using device ID as remote ID`);
          device.remote_id = device.device_id;
        }
      }
      if (device.use_remote_topic_id == null) {
        const autoRemote = shouldUseRemoteTopicId(device, broker);
        if (autoRemote) {
          device.use_remote_topic_id = true;
          logger.debug(`Enabled remote topic ID for device ${device.device_id}`);
        }
      }
      logger.debug(`Adding device ${device.device_id} to broker ${brokerId}`);
      (devicesByBroker[brokerId] ??= []).push(device);
    }

    logger.info(`\nConfigured devices: ${config.devices.length} total`);
    logger.info('------------------');
    config.devices.forEach((device, index) => {
      logger.info(`Device ${index + 1}:`);
      logger.info(`  Name: ${device.name || 'Not specified'}`);
      logger.info(`  Device ID: ${device.device_id}`);
      logger.info(`  Remote ID: ${device.remote_id}`);
      logger.info(`  MAC: ${device.mac}`);
      logger.info(`  Type: ${device.type}`);
      logger.info(`  Version: ${device.version ?? 'Unknown'}`);
      logger.info(`  Broker: ${device.broker_id}`);
      logger.info(`  Inverse Forwarding: ${device.inverse_forwarding ?? config.inverse_forwarding ?? false}`);
      logger.info(`  Use Remote Topic ID: ${device.use_remote_topic_id ?? false}`);
      logger.info('------------------');
    });
    logger.info('');

    const forwarders: MQTTForwarder[] = [];
    const healthServer = new HealthServer();

    for (const [id, devices] of Object.entries(devicesByBroker)) {
      logger.debug(`Setting up forwarder for broker ${id}`);
      const fconfig: ForwarderConfig = {
        broker_url: config.broker_url,
        devices,
        inverse_forwarding: config.inverse_forwarding,
        username: config.username,
        password: config.password,
        remote: brokers[id],
        broker_id: id
      };
      const fw = new MQTTForwarder(fconfig);
      forwarders.push(fw);
      healthServer.addBroker(id, fw.getRemoteBroker());
    }
    if (forwarders.length > 0) {
      healthServer.addBroker('local', forwarders[0].getConfigBroker());
    }

    process.on('SIGINT', () => {
      logger.info('Shutting down...');
      forwarders.forEach(f => f.close());
      healthServer.close();
      process.exit(0);
    });
  } catch (error: unknown) {
    logger.error(error, 'Failed to start MQTT forwarder');
    process.exit(1);
  }
}

// Start the application
start();
