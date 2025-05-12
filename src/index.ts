/**
 * DORM Chatroom Application
 *
 * A real-time chatroom application built with DORM (Durable Object Relational Mapping).
 *
 * Features:
 * - Multi-room support (each room has its own database)
 * - Username creation on room join
 * - Real-time message display
 * - Message history
 * - User presence tracking
 * - Aggregate database for all messages
 */

import {
  createClient,
  DORM,
  DORMClient,
  jsonSchemaToSql,
  TableSchema,
  type RemoteSqlStorageCursor,
  type Records,
} from "dormroom";

// Export DORM for Cloudflare
export { DORM };

export interface Env {
  DORM_NAMESPACE: DurableObjectNamespace<DORM>;
  DB_SECRET?: string;
}

// Database interfaces
interface Message extends Records {
  id: string;
  room_id: string;
  username: string;
  message: string;
  created_at: string;
}

interface User extends Records {
  username: string;
  room_id: string;
  last_seen: string;
}

interface Room extends Records {
  id: string;
  created_at: string;
}

// JSON Schema for rooms table
const roomSchema: TableSchema = {
  $id: "rooms",
  type: "object",
  properties: {
    id: {
      type: "string",
      "x-dorm-primary-key": true,
    },
    created_at: {
      type: "string",
      format: "date-time",
    },
  },
  required: ["id"],
};

// JSON Schema for messages table
const messageSchema: TableSchema = {
  $id: "messages",
  type: "object",
  properties: {
    id: {
      type: "string",
      "x-dorm-primary-key": true,
    },
    room_id: {
      type: "string",
    },
    username: {
      type: "string",
      maxLength: 50,
    },
    message: {
      type: "string",
      maxLength: 1000,
    },
    created_at: {
      type: "string",
      format: "date-time",
    },
  },
  required: ["id", "room_id", "username", "message"],
};

// JSON Schema for users table
const userSchema: TableSchema = {
  $id: "users",
  type: "object",
  properties: {
    username: {
      type: "string",
      maxLength: 50,
    },
    room_id: {
      type: "string",
    },
    last_seen: {
      type: "string",
      format: "date-time",
    },
  },
  required: ["username", "room_id"],
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const pathSegments = path
      .split("/")
      .filter((segment) => segment.length > 0);

    // Landing page
    if (pathSegments.length === 0) {
      return new Response(landingPageHtml(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    try {
      // Get room ID from the first segment
      const roomId = pathSegments[0];

      const connection =
        roomId === "aggregate"
          ? { name: "aggregate" }
          : {
              name: `room:${roomId}`,
              mirrorName: "aggregate",
            };

      // Create database client for the room
      const client: DORMClient = createClient({
        doNamespace: env.DORM_NAMESPACE,
        version: "v1",
        migrations: {
          1: jsonSchemaToSql(roomSchema)
            .concat(jsonSchemaToSql(messageSchema))
            .concat(jsonSchemaToSql(userSchema)),
        },
        ctx: ctx,
        ...connection,
      });

      // Ensure room exists
      if (roomId !== "aggregate") {
        await client
          .exec(
            "INSERT OR IGNORE INTO rooms (id, created_at) VALUES (?, ?)",
            roomId,
            new Date().toISOString(),
          )
          .toArray();
      }

      // Handle database API access
      if (path.startsWith(`/${roomId}/api/db`)) {
        const middlewareResponse = await client.middleware(request, {
          prefix: `/${roomId}/api/db`,
          secret: env.DB_SECRET || "my-secret-key",
        });

        if (middlewareResponse) {
          return middlewareResponse;
        }
      }

      const subPath =
        pathSegments.length > 1 ? "/" + pathSegments.slice(1).join("/") : "/";

      // API endpoint to get messages
      if (subPath === "/messages") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const before = url.searchParams.get("before");

        let query = "SELECT * FROM messages WHERE room_id = ?";
        const params: any[] = [roomId];

        if (before) {
          query += " AND created_at < ?";
          params.push(before);
        }

        query += " ORDER BY created_at DESC LIMIT ?";
        params.push(limit);

        const messages = await client.exec<Message>(query, ...params).toArray();

        return new Response(JSON.stringify(messages.reverse()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // API endpoint to send a message
      if (subPath === "/send" && request.method === "POST") {
        const data: any = await request.json();
        const { username, message } = data;

        if (!username || !message) {
          return new Response(
            JSON.stringify({ error: "Username and message required" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const id = crypto.randomUUID();
        const created_at = new Date().toISOString();

        await client
          .exec(
            "INSERT INTO messages (id, room_id, username, message, created_at) VALUES (?, ?, ?, ?, ?)",
            id,
            roomId,
            username,
            message,
            created_at,
          )
          .toArray();

        // Update user's last seen
        await client
          .exec(
            "INSERT OR REPLACE INTO users (username, room_id, last_seen) VALUES (?, ?, ?)",
            username,
            roomId,
            created_at,
          )
          .toArray();

        return new Response(JSON.stringify({ id, created_at }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // API endpoint to get active users
      if (subPath === "/users") {
        const fiveMinutesAgo = new Date(
          Date.now() - 5 * 60 * 1000,
        ).toISOString();

        const users = await client
          .exec<User>(
            "SELECT username, last_seen FROM users WHERE room_id = ? AND last_seen > ? ORDER BY last_seen DESC",
            roomId,
            fiveMinutesAgo,
          )
          .toArray();

        return new Response(JSON.stringify(users), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Default to chat room UI
      return new Response(chatRoomHtml(roomId), {
        headers: { "Content-Type": "text/html" },
      });
    } catch (error: any) {
      console.error("Error handling request:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

function landingPageHtml(): string {
  return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DORM Chatroom</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
          }
          .container {
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 40px;
            text-align: center;
          }
          h1 {
            color: #2563eb;
            margin-bottom: 30px;
          }
          .description {
            color: #666;
            margin-bottom: 40px;
            line-height: 1.6;
          }
          .room-form {
            display: flex;
            gap: 12px;
            justify-content: center;
            margin-bottom: 30px;
          }
          input {
            padding: 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 16px;
            flex: 1;
            max-width: 300px;
          }
          button {
            background: #2563eb;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            font-weight: 500;
            transition: background-color 0.2s;
          }
          button:hover {
            background: #1d4ed8;
          }
          .examples {
            margin-top: 40px;
            padding-top: 30px;
            border-top: 1px solid #e5e7eb;
          }
          .examples h3 {
            color: #4b5563;
            margin-bottom: 20px;
          }
          .room-links {
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
          }
          .room-link {
            background: #f3f4f6;
            color: #2563eb;
            text-decoration: none;
            padding: 10px 20px;
            border-radius: 8px;
            transition: background-color 0.2s;
          }
          .room-link:hover {
            background: #e5e7eb;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🗨️ DORM Chatroom</h1>
          <p class="description">
            Join or create a chatroom. Each room has its own database and message history.
            Choose a username when you enter the room.
          </p>
          
          <form class="room-form" onsubmit="joinRoom(event)">
            <input type="text" id="roomName" placeholder="Enter room name..." required>
            <button type="submit">Join Room</button>
          </form>
          
          <div class="examples">
            <h3>Popular Rooms</h3>
            <div class="room-links">
              <a href="/general" class="room-link">General</a>
              <a href="/tech" class="room-link">Tech</a>
              <a href="/random" class="room-link">Random</a>
              <a href="/gaming" class="room-link">Gaming</a>
            </div>
          </div>
        </div>
        
        <script>
          function joinRoom(event) {
            event.preventDefault();
            const roomName = document.getElementById('roomName').value.trim();
            if (roomName) {
              window.location.href = '/' + encodeURIComponent(roomName);
            }
          }
        </script>
      </body>
      </html>
    `;
}

function chatRoomHtml(roomId: string): string {
  return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Room: ${roomId} - DORM Chatroom</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0;
            padding: 0;
            background-color: #f5f5f5;
            height: 100vh;
            display: flex;
            flex-direction: column;
          }
          .header {
            background: white;
            border-bottom: 1px solid #e5e7eb;
            padding: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          .header h1 {
            margin: 0;
            color: #2563eb;
            font-size: 1.5rem;
          }
          .user-info {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .username-display {
            background: #f3f4f6;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 500;
            color: #4b5563;
          }
          .container {
            flex: 1;
            display: flex;
            overflow: hidden;
          }
          .main-chat {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: white;
            margin: 16px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .message {
            display: flex;
            gap: 12px;
            align-items: flex-start;
          }
          .message.own {
            flex-direction: row-reverse;
          }
          .message-content {
            background: #f3f4f6;
            padding: 12px 16px;
            border-radius: 12px;
            max-width: 70%;
            word-wrap: break-word;
          }
          .message.own .message-content {
            background: #2563eb;
            color: white;
          }
          .message-meta {
            font-size: 0.8rem;
            color: #6b7280;
            margin-top: 4px;
          }
          .message.own .message-meta {
            text-align: right;
          }
          .input-area {
            padding: 20px;
            border-top: 1px solid #e5e7eb;
            background: white;
          }
          .message-form {
            display: flex;
            gap: 12px;
          }
          .message-input {
            flex: 1;
            padding: 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 16px;
          }
          .send-button {
            background: #2563eb;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            font-weight: 500;
            transition: background-color 0.2s;
          }
          .send-button:hover {
            background: #1d4ed8;
          }
          .send-button:disabled {
            background: #9ca3af;
            cursor: not-allowed;
          }
          .sidebar {
            width: 200px;
            background: white;
            margin: 16px 16px 16px 0;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 20px;
          }
          .sidebar h3 {
            margin: 0 0 16px 0;
            color: #4b5563;
            font-size: 1rem;
          }
          .user-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .user-item {
            padding: 8px 12px;
            background: #f3f4f6;
            border-radius: 6px;
            font-size: 0.9rem;
            color: #374151;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .online-indicator {
            width: 8px;
            height: 8px;
            background: #10b981;
            border-radius: 50%;
          }
          .username-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
          }
          .username-modal.hidden {
            display: none;
          }
          .modal-content {
            background: white;
            padding: 32px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            max-width: 400px;
            width: 90%;
          }
          .modal-content h2 {
            margin: 0 0 20px 0;
            color: #2563eb;
          }
          .username-form {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .username-input {
            padding: 12px 16px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 16px;
          }
          @media (max-width: 768px) {
            .sidebar {
              display: none;
            }
            .message-content {
              max-width: 85%;
            }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🗨️ ${roomId}</h1>
          <div class="user-info">
            <div class="username-display" id="currentUsername">...</div>
            <a href="/" style="color: #6b7280; text-decoration: none;">Leave Room</a>
          </div>
        </div>
        
        <div class="container">
          <div class="main-chat">
            <div class="messages" id="messages"></div>
            <div class="input-area">
              <form class="message-form" onsubmit="sendMessage(event)">
                <input type="text" class="message-input" id="messageInput" placeholder="Type a message..." required disabled>
                <button type="submit" class="send-button" id="sendButton" disabled>Send</button>
              </form>
            </div>
          </div>
          
          <div class="sidebar">
            <h3>Active Users</h3>
            <div class="user-list" id="userList"></div>
          </div>
        </div>
        
        <div class="username-modal" id="usernameModal">
          <div class="modal-content">
            <h2>Welcome to ${roomId}</h2>
            <p>Choose a username to start chatting:</p>
            <form class="username-form" onsubmit="setUsername(event)">
              <input type="text" class="username-input" id="usernameInput" 
                     placeholder="Enter username..." required maxlength="50">
              <button type="submit" class="send-button">Join Chat</button>
            </form>
          </div>
        </div>
        
        <script>
          const roomId = ${JSON.stringify(roomId)};
          let username = localStorage.getItem('chatroom_username');
          let lastMessageTime = null;
          
          // Check if user has a username
          if (!username) {
            document.getElementById('usernameModal').classList.remove('hidden');
          } else {
            document.getElementById('currentUsername').textContent = username;
            document.getElementById('messageInput').disabled = false;
            document.getElementById('sendButton').disabled = false;
            loadMessages();
            startPolling();
          }
          
          function setUsername(event) {
            event.preventDefault();
            username = document.getElementById('usernameInput').value.trim();
            if (username) {
              localStorage.setItem('chatroom_username', username);
              document.getElementById('currentUsername').textContent = username;
              document.getElementById('usernameModal').classList.add('hidden');
              document.getElementById('messageInput').disabled = false;
              document.getElementById('sendButton').disabled = false;
              loadMessages();
              startPolling();
            }
          }
          
          async function loadMessages() {
            try {
              const response = await fetch('/' + roomId + '/messages');
              const messages = await response.json();
              
              const messagesDiv = document.getElementById('messages');
              messagesDiv.innerHTML = '';
              
              messages.forEach(msg => {
                addMessageToUI(msg);
              });
              
              if (messages.length > 0) {
                lastMessageTime = messages[messages.length - 1].created_at;
              }
              
              messagesDiv.scrollTop = messagesDiv.scrollHeight;
            } catch (error) {
              console.error('Error loading messages:', error);
            }
          }
          
          function addMessageToUI(msg) {
            const messagesDiv = document.getElementById('messages');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message' + (msg.username === username ? ' own' : '');
            
            const timestamp = new Date(msg.created_at).toLocaleTimeString();
            
            messageDiv.innerHTML = \`
              <div>
                <div class="message-content">\${escapeHtml(msg.message)}</div>
                <div class="message-meta">\${escapeHtml(msg.username)} · \${timestamp}</div>
              </div>
            \`;
            
            messagesDiv.appendChild(messageDiv);
          }
          
          async function sendMessage(event) {
            event.preventDefault();
            
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            
            if (!message || !username) return;
            
            try {
              const response = await fetch('/' + roomId + '/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, message }),
              });
              
              if (response.ok) {
                input.value = '';
                // The message will appear when we poll for new messages
              }
            } catch (error) {
              console.error('Error sending message:', error);
            }
          }
          
          async function loadUsers() {
            try {
              const response = await fetch('/' + roomId + '/users');
              const users = await response.json();
              
              const userList = document.getElementById('userList');
              userList.innerHTML = '';
              
              users.forEach(user => {
                const userDiv = document.createElement('div');
                userDiv.className = 'user-item';
                userDiv.innerHTML = \`
                  <div class="online-indicator"></div>
                  \${escapeHtml(user.username)}
                \`;
                userList.appendChild(userDiv);
              });
            } catch (error) {
              console.error('Error loading users:', error);
            }
          }
          
          function startPolling() {
            // Poll for new messages
            setInterval(async () => {
              try {
                const url = '/' + roomId + '/messages' + 
                  (lastMessageTime ? '?before=' + encodeURIComponent(new Date(Date.now() + 1000).toISOString()) : '');
                
                const response = await fetch(url);
                const messages = await response.json();
                
                const newMessages = lastMessageTime 
                  ? messages.filter(msg => msg.created_at > lastMessageTime)
                  : messages;
                
                newMessages.forEach(msg => {
                  addMessageToUI(msg);
                  lastMessageTime = msg.created_at;
                });
                
                if (newMessages.length > 0) {
                  const messagesDiv = document.getElementById('messages');
                  messagesDiv.scrollTop = messagesDiv.scrollHeight;
                }
              } catch (error) {
                console.error('Error polling messages:', error);
              }
            }, 1000);
            
            // Poll for active users
            loadUsers();
            setInterval(loadUsers, 5000);
          }
          
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
        </script>
      </body>
      </html>
    `;
}
