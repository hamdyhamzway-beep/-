import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { desc, eq, or } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { chatChannels, chatMessages, drivers, routes, schools, supervisors } from '../db/schema.ts';
import type { ChatChannel, ChatMessage } from '../types/index.ts';

interface ClientMeta {
  userId?: number;
  role: string;
  name: string;
  rooms: Set<string>;
}

const clientsMap = new Map<WebSocket, ClientMeta>();
let wssInstance: WebSocketServer | null = null;

export const DRIVERS_BROADCAST_ROOM = 'drivers_broadcast';

function isSupervisorRole(role?: string): boolean {
  return role === 'supervisor';
}

function isDriverOrStaffRole(role?: string): boolean {
  return (
    role === 'driver' ||
    role === 'super_admin' ||
    role === 'admin' ||
    role === 'movement_manager' ||
    role === 'accountant'
  );
}

/**
 * Initializes the WebSocket server for real-time messaging, voice notes, and live audio/PTT calls.
 * Uses noServer mode attached to the existing HTTP server on path '/ws/chat'.
 */
export function initChatWebSocketServer(httpServer: http.Server) {
  if (wssInstance) return wssInstance;

  const wss = new WebSocketServer({ noServer: true });
  wssInstance = wss;

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const host = request.headers.host || 'localhost:3000';
      const pathname = request.url ? new URL(request.url, `http://${host}`).pathname : '';
      if (pathname === '/ws/chat') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    } catch (err) {
      console.warn('[Chat WS] Upgrade handling warning:', err);
    }
  });

  wss.on('connection', (ws) => {
    const meta: ClientMeta = {
      role: 'anonymous',
      name: 'مستخدم',
      rooms: new Set(['broadcast']),
    };
    clientsMap.set(ws, meta);

    ws.on('message', async (raw) => {
      try {
        const text = raw.toString();
        const payload = JSON.parse(text);

        if (payload.type === 'auth') {
          meta.userId = payload.userId;
          meta.role = payload.role || 'user';
          meta.name = payload.name || 'مستخدم';
          if (isDriverOrStaffRole(meta.role)) {
            meta.rooms.add(DRIVERS_BROADCAST_ROOM);
          } else {
            meta.rooms.delete(DRIVERS_BROADCAST_ROOM);
          }
          if (Array.isArray(payload.initialRooms)) {
            payload.initialRooms.forEach((r: string) => {
              if (r === DRIVERS_BROADCAST_ROOM && isSupervisorRole(meta.role)) return;
              meta.rooms.add(r);
            });
          }
          ws.send(JSON.stringify({ type: 'authenticated', rooms: Array.from(meta.rooms) }));
          return;
        }

        if (payload.type === 'join_room' && payload.roomKey) {
          if (payload.roomKey === DRIVERS_BROADCAST_ROOM && isSupervisorRole(meta.role)) {
            ws.send(JSON.stringify({ type: 'error', message: 'غير مصرح بالوصول لقناة السائقين فقط' }));
            return;
          }
          meta.rooms.add(payload.roomKey);
          ws.send(JSON.stringify({ type: 'room_joined', roomKey: payload.roomKey }));
          return;
        }

        if (payload.type === 'leave_room' && payload.roomKey) {
          meta.rooms.delete(payload.roomKey);
          ws.send(JSON.stringify({ type: 'room_left', roomKey: payload.roomKey }));
          return;
        }

        // Live Audio Call Signaling & Push-To-Talk (PTT) streams
        if (payload.type === 'call_signal' && payload.roomKey) {
          if (payload.roomKey === DRIVERS_BROADCAST_ROOM && isSupervisorRole(meta.role)) {
            return;
          }
          broadcastToRoom(payload.roomKey, {
            type: 'call_signal',
            roomKey: payload.roomKey,
            action: payload.action,
            callerName: payload.callerName || meta.name,
            callerRole: payload.callerRole || meta.role,
            sdpOrCandidate: payload.sdpOrCandidate,
            pttAudioData: payload.pttAudioData,
          }, ws);

          if (payload.action === 'call_start') {
            await saveMessageToDb({
              roomKey: payload.roomKey,
              senderRole: meta.role,
              senderName: meta.name,
              messageType: 'call_log',
              textContent: `بدأت مكالمة صوتية مباشرة بواسطة ${meta.name}`,
            });
          }
          return;
        }

        // New Message (Text or Voice Note) sent via WebSocket
        if (payload.type === 'send_message' && payload.roomKey) {
          if (payload.roomKey === DRIVERS_BROADCAST_ROOM && isSupervisorRole(meta.role)) {
            ws.send(JSON.stringify({ type: 'error', message: 'غير مصرح بالإرسال في قناة السائقين' }));
            return;
          }
          const saved = await saveMessageToDb({
            roomKey: payload.roomKey,
            senderUserId: meta.userId,
            senderRole: meta.role,
            senderName: meta.name,
            senderAvatar: payload.senderAvatar,
            messageType: payload.messageType || 'text',
            textContent: payload.textContent || '',
            audioDataUrl: payload.audioDataUrl,
            audioDurationSec: payload.audioDurationSec || 0,
          });

          broadcastToRoom(payload.roomKey, {
            type: 'new_message',
            roomKey: payload.roomKey,
            message: saved,
          });
          return;
        }
      } catch (err) {
        console.warn('[Chat WS] Message parsing error:', err);
      }
    });

    ws.on('close', () => {
      clientsMap.delete(ws);
    });

    ws.on('error', (err) => {
      console.warn('[Chat WS] Client error:', err);
      clientsMap.delete(ws);
    });

    // Send connection ACK
    ws.send(JSON.stringify({ type: 'connected', serverTime: new Date().toISOString() }));
  });

  return wss;
}

/**
 * Broadcasts an event payload to all clients subscribed to the specific roomKey.
 * If roomKey is 'broadcast', sends to all connected clients.
 * If roomKey is 'drivers_broadcast', strictly excludes supervisors & anonymous sockets.
 */
export function broadcastToRoom(roomKey: string, payload: any, senderWs?: WebSocket) {
  const messageStr = JSON.stringify(payload);
  for (const [clientWs, meta] of clientsMap.entries()) {
    if (clientWs !== senderWs && clientWs.readyState === WebSocket.OPEN) {
      if (roomKey === DRIVERS_BROADCAST_ROOM) {
        if (!isSupervisorRole(meta.role) && isDriverOrStaffRole(meta.role)) {
          try {
            clientWs.send(messageStr);
          } catch {
            // ignore dead socket
          }
        }
      } else if (roomKey === 'broadcast' || meta.rooms.has(roomKey)) {
        try {
          clientWs.send(messageStr);
        } catch {
          // ignore dead socket
        }
      }
    }
  }
}

/**
 * Saves a message into the PostgreSQL database and updates channel summary.
 */
export async function saveMessageToDb(data: {
  roomKey: string;
  channelId?: number | null;
  senderUserId?: number | null;
  senderRole: string;
  senderName: string;
  senderAvatar?: string | null;
  messageType: 'text' | 'voice_note' | 'call_log' | 'ptt_audio' | 'system';
  textContent?: string;
  audioDataUrl?: string | null;
  audioDurationSec?: number;
}): Promise<ChatMessage> {
  let chId = data.channelId || null;

  // Find or create channel
  if (!chId) {
    const existingChan = await db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(eq(chatChannels.roomKey, data.roomKey))
      .limit(1);

    if (existingChan.length > 0) {
      chId = existingChan[0].id;
    } else {
      let title = 'محادثة مباشرة';
      let channelType: 'broadcast' | 'drivers_broadcast' | 'route' | 'direct' = 'direct';

      if (data.roomKey === 'broadcast') {
        title = 'غرفة العمليات والطوارئ العامة';
        channelType = 'broadcast';
      } else if (data.roomKey === DRIVERS_BROADCAST_ROOM) {
        title = 'رسائل جماعية للسائقين (خاص بالسائقين فقط)';
        channelType = 'drivers_broadcast';
      } else if (data.roomKey.startsWith('route_')) {
        const routeId = parseInt(data.roomKey.replace('route_', ''), 10);
        title = `محادثة خط السير #${routeId}`;
        channelType = 'route';
      }

      const [newChan] = await db
        .insert(chatChannels)
        .values({
          roomKey: data.roomKey,
          channelType,
          title,
          lastMessageText: data.textContent || (data.messageType === 'voice_note' ? '🎤 رسالة صوتية' : 'مكالمة صوتية'),
          lastMessageAt: new Date(),
        })
        .returning({ id: chatChannels.id });
      chId = newChan.id;
    }
  }

  const [saved] = await db
    .insert(chatMessages)
    .values({
      channelId: chId,
      roomKey: data.roomKey,
      senderUserId: data.senderUserId || null,
      senderRole: data.senderRole,
      senderName: data.senderName,
      senderAvatar: data.senderAvatar || '',
      messageType: data.messageType,
      textContent: data.textContent || '',
      audioDataUrl: data.audioDataUrl || null,
      audioDurationSec: data.audioDurationSec || 0,
      isRead: false,
    })
    .returning();

  // Update channel last message info
  const preview =
    data.messageType === 'voice_note'
      ? `🎤 رسالة صوتية (${data.audioDurationSec || 0}ث)`
      : data.messageType === 'call_log'
      ? '📞 مكالمة صوتية'
      : data.textContent || 'رسالة جديدة';

  await db
    .update(chatChannels)
    .set({
      lastMessageText: preview,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(chatChannels.id, chId));

  return {
    id: saved.id,
    channelId: saved.channelId,
    roomKey: saved.roomKey,
    senderUserId: saved.senderUserId,
    senderRole: saved.senderRole,
    senderName: saved.senderName,
    senderAvatar: saved.senderAvatar,
    messageType: saved.messageType as any,
    textContent: saved.textContent || '',
    audioDataUrl: saved.audioDataUrl,
    audioDurationSec: saved.audioDurationSec || 0,
    isRead: saved.isRead,
    createdAt: saved.createdAt.toISOString(),
  };
}

/**
 * Gets all active chat channels and ensures route & broadcast channels exist.
 * Excludes drivers-only broadcast room for supervisor role.
 */
export async function getEnrichedChatChannels(viewerRole?: string): Promise<ChatChannel[]> {
  // Synchronize route channels from routes table
  const allRoutes = await db
    .select({
      id: routes.id,
      name: routes.name,
      schoolId: routes.schoolId,
    })
    .from(routes);

  for (const r of allRoutes) {
    const rKey = `route_${r.id}`;
    const exists = await db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(eq(chatChannels.roomKey, rKey))
      .limit(1);

    if (exists.length === 0) {
      await db
        .insert(chatChannels)
        .values({
          roomKey: rKey,
          channelType: 'route',
          title: `خط ${r.name}`,
          routeId: r.id,
          schoolId: r.schoolId,
          lastMessageText: 'غرفة محادثة خط السير نشطة',
          lastMessageAt: new Date(),
        })
        .onConflictDoNothing();
    }
  }

  // Ensure general broadcast exists
  const bcExists = await db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(eq(chatChannels.roomKey, 'broadcast'))
    .limit(1);

  if (bcExists.length === 0) {
    await db
      .insert(chatChannels)
      .values({
        roomKey: 'broadcast',
        channelType: 'broadcast',
        title: 'غرفة العمليات والطوارئ العامة',
        lastMessageText: 'مرحباً بكم في شبكة التواصل الموحدة',
        lastMessageAt: new Date(),
      })
      .onConflictDoNothing();
  }

  // Ensure driver-only broadcast exists
  const dbcExists = await db
    .select({ id: chatChannels.id })
    .from(chatChannels)
    .where(eq(chatChannels.roomKey, DRIVERS_BROADCAST_ROOM))
    .limit(1);

  if (dbcExists.length === 0) {
    await db
      .insert(chatChannels)
      .values({
        roomKey: DRIVERS_BROADCAST_ROOM,
        channelType: 'drivers_broadcast',
        title: 'رسائل جماعية للسائقين (خاص بالسائقين فقط)',
        lastMessageText: 'قناة الرسائل الجماعية والفويس نوت من الإدارة للسائقين فقط',
        lastMessageAt: new Date(),
      })
      .onConflictDoNothing();
  }

  // Load channels with route/school names
  const rows = await db
    .select({
      channel: chatChannels,
      routeName: routes.name,
      schoolName: schools.name,
      driverName: drivers.fullName,
      supervisorName: supervisors.fullName,
    })
    .from(chatChannels)
    .leftJoin(routes, eq(chatChannels.routeId, routes.id))
    .leftJoin(schools, eq(chatChannels.schoolId, schools.id))
    .leftJoin(drivers, eq(chatChannels.driverId, drivers.id))
    .leftJoin(supervisors, eq(chatChannels.supervisorId, supervisors.id))
    .orderBy(desc(chatChannels.lastMessageAt));

  return rows
    .filter((r) => {
      if (isSupervisorRole(viewerRole)) {
        return (
          r.channel.roomKey !== DRIVERS_BROADCAST_ROOM &&
          r.channel.channelType !== 'drivers_broadcast'
        );
      }
      return true;
    })
    .map((r) => {
      const c = r.channel;
      return {
        id: c.id,
        roomKey: c.roomKey,
        channelType: c.channelType as ChatChannel['channelType'],
        title: c.title,
        routeId: c.routeId,
        routeName: r.routeName || undefined,
        schoolId: c.schoolId,
        schoolName: r.schoolName || undefined,
        driverId: c.driverId,
        driverName: r.driverName || undefined,
        supervisorId: c.supervisorId,
        supervisorName: r.supervisorName || undefined,
        lastMessageText: c.lastMessageText,
        lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : c.createdAt.toISOString(),
        onlineParticipantsCount: Math.max(1, countClientsInRoom(c.roomKey)),
      };
    });
}

/**
 * Counts currently connected live WebSocket clients in a given room.
 */
export function countClientsInRoom(roomKey: string): number {
  let count = 0;
  for (const [, meta] of clientsMap.entries()) {
    if (roomKey === DRIVERS_BROADCAST_ROOM) {
      if (!isSupervisorRole(meta.role) && isDriverOrStaffRole(meta.role)) {
        count++;
      }
    } else if (roomKey === 'broadcast' || meta.rooms.has(roomKey)) {
      count++;
    }
  }
  return count;
}

/**
 * Fetches recent messages for a room.
 */
export async function getMessagesForRoom(roomKey: string, limit = 80): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.roomKey, roomKey))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);

  // Return chronologically (oldest to newest)
  rows.reverse();

  return rows.map((m) => ({
    id: m.id,
    channelId: m.channelId,
    roomKey: m.roomKey,
    senderUserId: m.senderUserId,
    senderRole: m.senderRole,
    senderName: m.senderName,
    senderAvatar: m.senderAvatar,
    messageType: m.messageType as any,
    textContent: m.textContent || '',
    audioDataUrl: m.audioDataUrl,
    audioDurationSec: m.audioDurationSec || 0,
    isRead: m.isRead,
    createdAt: m.createdAt.toISOString(),
  }));
}
