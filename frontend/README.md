# MCP Agent Web UI

A simple web interface to interact with the MCP Agent.

## Features

- **Chat Interface**: Send messages and receive responses from the agent
- **Real-time Logs**: See all tool usage and agent activity in real-time
- **Markdown Support**: Agent responses are rendered with proper markdown formatting
- **WebSocket Connection**: Live bidirectional communication with the server

## Usage

### Starting the Web Server

To run the agent with the web UI, use the `--web` flag:

```bash
npm start -- --web
```

Or if running directly:

```bash
node build/index.js --web
```

The server will start on port 3000 by default. You can change this by setting the `PORT` environment variable:

```bash
PORT=8080 npm start -- --web
```

### Accessing the UI

Once the server is running, open your browser and navigate to:

```
http://localhost:3000
```

### CLI Mode

To use the traditional command-line interface (without the web UI), simply run:

```bash
npm start
```

## UI Layout

The interface is divided into two main sections:

1. **Left Panel - Chat**:
   - Type your messages in the input field at the bottom
   - Press Enter or click Send to submit
   - Your messages and agent responses are displayed here
   - Agent responses support markdown formatting (headers, lists, code blocks, etc.)

2. **Right Panel - Logs**:
   - Shows real-time logs of all agent activities
   - Tool usage is highlighted with yellow color
   - Errors are shown in red
   - Success messages are shown in green
   - Click "Clear" to clear the log history

## Features

- Auto-reconnect on connection loss
- Scrollable chat and log panels
- Responsive design
- Connection status indicator in the header
