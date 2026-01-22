/**
 * HTTP and WebSocket API client for LocalBot Dashboard
 */

import { setState, setNestedState, setLoading, getState } from './state.js';

// API base URL
const API_BASE = window.location.origin;

// WebSocket connection
let ws = null;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
const WS_MAX_RECONNECT_ATTEMPTS = 10;
const WS_RECONNECT_DELAY = 2000;

// Event subscribers
const eventSubscribers = new Map();

/**
 * Make HTTP API request
 */
async function apiRequest(endpoint, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`API request failed: ${endpoint}`, error);
    throw error;
  }
}

/**
 * Fetch health status
 */
export async function fetchHealth() {
  setLoading('health', true);
  try {
    const data = await apiRequest('/health');
    setState({ health: data, services: Object.values(data.services || {}) });
    return data;
  } finally {
    setLoading('health', false);
  }
}

/**
 * Fetch services
 */
export async function fetchServices() {
  try {
    const data = await apiRequest('/services');
    setState({ services: Object.values(data) });
    return data;
  } catch (error) {
    console.error('Failed to fetch services:', error);
    return null;
  }
}

/**
 * Fetch sessions
 */
export async function fetchSessions() {
  setLoading('sessions', true);
  try {
    const data = await apiRequest('/api/sessions');
    setState({ sessions: data });
    return data;
  } finally {
    setLoading('sessions', false);
  }
}

/**
 * Fetch activity log
 */
export async function fetchActivity(limit = 50, source = null) {
  setLoading('activity', true);
  try {
    let url = `/api/activity?limit=${limit}`;
    if (source) url += `&source=${source}`;
    const data = await apiRequest(url);
    setState({ activity: data });
    return data;
  } finally {
    setLoading('activity', false);
  }
}

/**
 * Fetch tools
 */
export async function fetchTools() {
  setLoading('tools', true);
  try {
    const data = await apiRequest('/api/tools');
    setState({ tools: data.tools || [] });
    return data;
  } finally {
    setLoading('tools', false);
  }
}

/**
 * Fetch cron jobs
 */
export async function fetchCron() {
  setLoading('cron', true);
  try {
    const data = await apiRequest('/cron');
    setState({ cron: Array.isArray(data) ? data : [] });
    return data;
  } finally {
    setLoading('cron', false);
  }
}

/**
 * Fetch metrics
 */
export async function fetchMetrics() {
  setLoading('metrics', true);
  try {
    const data = await apiRequest('/api/metrics');
    setState({ metrics: data });
    return data;
  } finally {
    setLoading('metrics', false);
  }
}

/**
 * Fetch Ollama status
 */
export async function fetchOllama() {
  setLoading('ollama', true);
  try {
    const data = await apiRequest('/api/ollama');
    setState({ ollama: data });
    return data;
  } finally {
    setLoading('ollama', false);
  }
}

/**
 * Fetch events from database
 */
export async function fetchEvents(options = {}) {
  setLoading('events', true);
  try {
    const params = new URLSearchParams();
    if (options.channel) params.set('channel', options.channel);
    if (options.type) params.set('type', options.type);
    if (options.level) params.set('level', options.level);
    if (options.limit) params.set('limit', options.limit);
    if (options.offset) params.set('offset', options.offset);

    const data = await apiRequest(`/api/events?${params}`);
    setState({ events: data.events || [] });
    return data;
  } finally {
    setLoading('events', false);
  }
}

/**
 * Fetch event filter options
 */
export async function fetchEventTypes() {
  try {
    const data = await apiRequest('/api/events/types');
    setState({ eventTypes: data });
    return data;
  } catch (error) {
    console.error('Failed to fetch event types:', error);
    return null;
  }
}

/**
 * Fetch database sessions with details
 */
export async function fetchDbSessions(options = {}) {
  setLoading('dbSessions', true);
  try {
    const params = new URLSearchParams();
    if (options.channel) params.set('channel', options.channel);
    if (options.userId) params.set('user_id', options.userId);
    if (options.limit) params.set('limit', options.limit || 50);
    if (options.offset) params.set('offset', options.offset || 0);

    const data = await apiRequest(`/api/db/sessions?${params}`);
    setState({ dbSessions: data.sessions || [] });
    return data;
  } finally {
    setLoading('dbSessions', false);
  }
}

/**
 * Fetch session with messages
 */
export async function fetchSessionMessages(sessionId) {
  setLoading('sessionDetail', true);
  try {
    const data = await apiRequest(`/api/sessions/${sessionId}/messages`);
    setState({ selectedSession: data });
    return data;
  } finally {
    setLoading('sessionDetail', false);
  }
}

/**
 * Fetch memory status
 */
export async function fetchMemoryStatus() {
  setLoading('memory', true);
  try {
    const data = await apiRequest('/api/memory/status');
    setState({ memory: data });
    return data;
  } finally {
    setLoading('memory', false);
  }
}

/**
 * Trigger memory sync
 */
export async function triggerMemorySync(sessionId = null) {
  try {
    const options = {
      method: 'POST',
    };
    if (sessionId) {
      options.body = JSON.stringify({ sessionId });
    }
    const data = await apiRequest('/api/memory/sync', options);
    // Refresh memory status after sync
    fetchMemoryStatus();
    return data;
  } catch (error) {
    console.error('Memory sync failed:', error);
    throw error;
  }
}

/**
 * Fetch memory sync history
 */
export async function fetchMemoryHistory(options = {}) {
  try {
    const params = new URLSearchParams();
    if (options.channel) params.set('channel', options.channel);
    if (options.limit) params.set('limit', options.limit || 50);

    const data = await apiRequest(`/api/memory/history?${params}`);
    setState({ memoryHistory: data.history || [] });
    return data;
  } catch (error) {
    console.error('Failed to fetch memory history:', error);
    return null;
  }
}

/**
 * Fetch workspace files (SOUL, MEMORY, etc.)
 */
export async function fetchWorkspace() {
  setLoading('workspace', true);
  try {
    const data = await apiRequest('/api/workspace');
    setState({ workspace: data });
    return data;
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    return null;
  } finally {
    setLoading('workspace', false);
  }
}

/**
 * Fetch all dashboard data
 */
export async function fetchAll() {
  await Promise.all([
    fetchHealth(),
    fetchSessions(),
    fetchActivity(),
    fetchTools(),
    fetchCron(),
    fetchMetrics(),
    fetchOllama(),
  ]);
}

/**
 * Connect WebSocket
 */
export function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  console.log('[WS] Connecting to', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected');
    setState({ connected: true });
    wsReconnectAttempts = 0;
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected');
    setState({ connected: false });
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error('[WS] Error:', error);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsMessage(data);
    } catch (error) {
      console.error('[WS] Failed to parse message:', error);
    }
  };
}

/**
 * Handle WebSocket message
 */
function handleWsMessage(data) {
  if (data.type === 'event') {
    // Emit to subscribers
    const subscribers = eventSubscribers.get(data.event) || [];
    for (const callback of subscribers) {
      try {
        callback(data.payload);
      } catch (error) {
        console.error('[WS] Event handler error:', error);
      }
    }

    // Handle specific events
    switch (data.event) {
      case 'connected':
        if (data.payload.services) {
          setState({ services: Object.values(data.payload.services) });
        }
        break;

      case 'activity':
        // Prepend new activity to list
        const state = getState();
        const entries = [data.payload, ...state.activity.entries].slice(0, 100);
        setNestedState('activity.entries', entries);
        break;

      case 'service.status':
        fetchServices();
        break;

      case 'metrics':
        setState({ metrics: data.payload });
        break;
    }
  }
}

/**
 * Schedule WebSocket reconnection
 */
function scheduleReconnect() {
  if (wsReconnectTimer) return;
  if (wsReconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
    console.log('[WS] Max reconnect attempts reached');
    return;
  }

  const delay = WS_RECONNECT_DELAY * Math.pow(1.5, wsReconnectAttempts);
  wsReconnectAttempts++;

  console.log(`[WS] Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts})`);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket();
  }, delay);
}

/**
 * Send WebSocket request
 */
export function wsRequest(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[WS] Not connected');
    return Promise.reject(new Error('WebSocket not connected'));
  }

  return new Promise((resolve, reject) => {
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const handler = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'response' && data.id === id) {
          ws.removeEventListener('message', handler);
          if (data.ok) {
            resolve(data.payload);
          } else {
            reject(new Error(data.error));
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    };

    ws.addEventListener('message', handler);

    // Timeout after 30s
    setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('Request timeout'));
    }, 30000);

    ws.send(JSON.stringify({
      type: 'request',
      id,
      method,
      params,
    }));
  });
}

/**
 * Subscribe to WebSocket events
 */
export function onEvent(event, callback) {
  if (!eventSubscribers.has(event)) {
    eventSubscribers.set(event, new Set());
  }
  eventSubscribers.get(event).add(callback);

  return () => {
    const subscribers = eventSubscribers.get(event);
    if (subscribers) {
      subscribers.delete(callback);
    }
  };
}

/**
 * Service control via WebSocket
 */
export async function startService(name) {
  return wsRequest('services.start', { name });
}

export async function stopService(name) {
  return wsRequest('services.stop', { name });
}

export async function restartService(name) {
  return wsRequest('services.restart', { name });
}

// ============================================
// Chat API (Interactive conversation)
// ============================================

// Chat message handler for streaming
let chatStreamHandler = null;

/**
 * Start a new chat session
 */
export async function startChatSession(model = null) {
  setLoading('chat', true);
  try {
    const result = await wsRequest('chat.start', { model });
    setNestedState('chat.sessionId', result.sessionId);
    setNestedState('chat.model', result.model);
    setNestedState('chat.messages', []);
    setNestedState('chat.error', null);
    return result;
  } catch (error) {
    setNestedState('chat.error', error.message);
    throw error;
  } finally {
    setLoading('chat', false);
  }
}

/**
 * Load an existing chat session
 */
export async function loadChatSession(sessionId) {
  setLoading('chat', true);
  try {
    const result = await wsRequest('chat.load', { sessionId });
    setNestedState('chat.sessionId', result.sessionId);
    setNestedState('chat.model', result.model);
    setNestedState('chat.messages', result.messages || []);
    setNestedState('chat.error', null);
    return result;
  } catch (error) {
    setNestedState('chat.error', error.message);
    throw error;
  } finally {
    setLoading('chat', false);
  }
}

/**
 * Send a chat message and handle streaming response
 */
export async function sendChatMessage(content) {
  const state = getState();
  if (!state.chat.sessionId) {
    throw new Error('No active chat session');
  }

  // Add user message to state immediately
  const userMessage = { role: 'user', content, timestamp: Date.now() };
  const currentMessages = [...state.chat.messages, userMessage];
  setNestedState('chat.messages', currentMessages);
  setNestedState('chat.streaming', true);
  setNestedState('chat.streamingContent', '');
  setNestedState('chat.error', null);

  // Setup streaming handler
  setupChatStreamHandler();

  try {
    // Send message via WebSocket - response will come via events
    ws.send(JSON.stringify({
      type: 'request',
      method: 'chat.send',
      params: {
        sessionId: state.chat.sessionId,
        content,
      },
    }));
  } catch (error) {
    setNestedState('chat.streaming', false);
    setNestedState('chat.error', error.message);
    throw error;
  }
}

/**
 * Setup handler for chat stream events
 */
function setupChatStreamHandler() {
  // Remove existing handler if any
  if (chatStreamHandler) {
    ws.removeEventListener('message', chatStreamHandler);
  }

  chatStreamHandler = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'event' && data.event === 'chat.chunk') {
        // Streaming content chunk
        const state = getState();
        const newContent = state.chat.streamingContent + (data.payload.content || '');
        setNestedState('chat.streamingContent', newContent);
      } else if (data.type === 'event' && data.event === 'chat.tool') {
        // Tool execution notification
        const state = getState();
        const toolMsg = {
          role: 'tool',
          name: data.payload.name,
          content: data.payload.result,
          timestamp: Date.now(),
        };
        setNestedState('chat.messages', [...state.chat.messages, toolMsg]);
      } else if (data.type === 'event' && data.event === 'chat.done') {
        // Response complete
        const state = getState();
        const assistantMessage = {
          role: 'assistant',
          content: state.chat.streamingContent || data.payload.content,
          timestamp: Date.now(),
          toolCalls: data.payload.toolCalls,
        };
        setNestedState('chat.messages', [...state.chat.messages, assistantMessage]);
        setNestedState('chat.streaming', false);
        setNestedState('chat.streamingContent', '');

        // Clean up handler
        ws.removeEventListener('message', chatStreamHandler);
        chatStreamHandler = null;
      } else if (data.type === 'event' && data.event === 'chat.error') {
        // Error during chat
        setNestedState('chat.streaming', false);
        setNestedState('chat.error', data.payload.error);

        // Clean up handler
        ws.removeEventListener('message', chatStreamHandler);
        chatStreamHandler = null;
      }
    } catch (e) {
      // Ignore parse errors
    }
  };

  ws.addEventListener('message', chatStreamHandler);
}

/**
 * Clear chat session
 */
export function clearChat() {
  setNestedState('chat.sessionId', null);
  setNestedState('chat.messages', []);
  setNestedState('chat.streaming', false);
  setNestedState('chat.streamingContent', '');
  setNestedState('chat.model', null);
  setNestedState('chat.error', null);
}

/**
 * Get available models for chat
 */
export async function fetchChatModels() {
  try {
    const data = await apiRequest('/api/ollama');
    return data.models || [];
  } catch (error) {
    console.error('Failed to fetch models:', error);
    return [];
  }
}
