# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- `npm install` - Install dependencies
- `npm run build` - Build TypeScript to JavaScript (compiles src/ to dist/)
- `npm run dev` - Run in development mode with ts-node
- `npm start` - Run the compiled application
- `npm run clean` - Remove dist directory

### Docker
- Build: `docker build -t hame-relay .`
- Run: `docker run -d --name hame-relay -v "$(pwd)/config:/app/config" ghcr.io/tomquist/hame-relay:latest`

## Architecture

### Core Components

**MQTTForwarder** (src/forwarder.ts:197-599)
- Main relay service that forwards MQTT messages between local and remote brokers
- Handles two forwarding modes:
  - Normal forwarding (`inverse_forwarding: false`): Device on local broker, maintain app functionality
  - Inverse forwarding (`inverse_forwarding: true`): Device on Hame broker, enable local control
- Implements rate limiting for specific message codes (1, 13, 15, 16, 21, 26, 28, 30)
- Uses instance IDs in message headers to prevent forwarding loops
- Maintains message history to ensure proper request/response pairing

**Topic Structure Management**
- Different topic patterns based on broker and configuration:
  - Local broker with `use_remote_topic_id=false`: `{local_topic_prefix}{type}/App|device/{mac}/ctrl`
  - Local broker with `use_remote_topic_id=true`: `{topic_prefix}{type}/App|device/{remote_id}/ctrl`
  - Remote broker: Always uses `{topic_prefix}{type}/App|device/{remote_id}/ctrl`
- Remote ID calculated using AES-128-CBC encryption when topic_encryption_key is provided

**Device Configuration**
- Supports multiple Marstek storage systems (Saturn/B2500, Venus, Jupiter)
- Device types follow pattern: `HM{A|B|D|E|F|G|J|K|I|M|N}-{1-16|25|50}` or `JPLS-8H`
- Auto-selects broker based on device version and min_versions configuration
- Can fetch device info from Hame API using credentials

**Broker Selection**
- Two preconfigured brokers: `hame-2024` (legacy) and `hame-2025` (newer firmware)
- Auto-selection based on firmware version when available
- Certificates and keys loaded from certs/ directory via @file references in brokers.json

### Key Data Flow

1. **Subscription Setup**: Subscribe to appropriate topics on both brokers based on device configuration
2. **Message Forwarding**: 
   - App messages trigger device response forwarding
   - Rate limiting applied to specific message codes
   - Topic translation between local and remote structures
3. **Loop Prevention**: Instance IDs in message headers prevent relay loops

### Configuration Files

- `config/config.json`: Main configuration with devices, credentials, and broker URL
- `brokers.json`: Remote broker definitions with certificates, URLs, and version mappings
- `certs/`: Directory containing broker certificates and keys (referenced by brokers.json)

### Important Considerations

- Venus and Jupiter devices require `inverse_forwarding: true` (cannot use local MQTT)
- Saturn/B2500 can use either forwarding mode
- Rate limiting helps prevent overwhelming the Hame broker
- Device MAC addresses must be without colons and lowercase
- Home Assistant addon auto-discovers MQTT service if available