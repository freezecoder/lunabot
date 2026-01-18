/**
 * Heartbeat Configuration
 */

/**
 * Heartbeat configuration interface
 */
export interface HeartbeatConfig {
  enabled: boolean;
  every: number;           // Interval in minutes (default: 30)
  prompt: string;          // Heartbeat prompt to send
  target?: string;         // Channel/chat ID to deliver to
  ackMaxChars: number;     // Max response length for acknowledgment (default: 300)
  startDelay?: number;     // Delay before first heartbeat in minutes
}

/**
 * Default heartbeat configuration
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: false,
  every: 30,
  prompt: `Read HEARTBEAT.md if it exists and check:
1. Are there any scheduled tasks due?
2. Any reminders that need attention?
3. Any background processes to check on?

If nothing needs attention, respond with exactly "HEARTBEAT_OK".
If something needs attention, explain what and take appropriate action.`,
  ackMaxChars: 300,
  startDelay: 5,
};

/**
 * Special response indicating no action needed
 */
export const HEARTBEAT_OK = 'HEARTBEAT_OK';

/**
 * Load heartbeat config from environment
 */
export function loadHeartbeatConfig(): HeartbeatConfig {
  const config: HeartbeatConfig = { ...DEFAULT_HEARTBEAT_CONFIG };

  // Enable/disable
  if (process.env.LOCALBOT_HEARTBEAT_ENABLED) {
    config.enabled = process.env.LOCALBOT_HEARTBEAT_ENABLED === 'true';
  }

  // Interval
  if (process.env.LOCALBOT_HEARTBEAT_EVERY) {
    const every = parseInt(process.env.LOCALBOT_HEARTBEAT_EVERY, 10);
    if (!isNaN(every) && every > 0) {
      config.every = every;
    }
  }

  // Custom prompt
  if (process.env.LOCALBOT_HEARTBEAT_PROMPT) {
    config.prompt = process.env.LOCALBOT_HEARTBEAT_PROMPT;
  }

  // Target channel
  if (process.env.LOCALBOT_HEARTBEAT_TARGET) {
    config.target = process.env.LOCALBOT_HEARTBEAT_TARGET;
  }

  // Ack max chars
  if (process.env.LOCALBOT_HEARTBEAT_ACK_MAX_CHARS) {
    const maxChars = parseInt(process.env.LOCALBOT_HEARTBEAT_ACK_MAX_CHARS, 10);
    if (!isNaN(maxChars) && maxChars > 0) {
      config.ackMaxChars = maxChars;
    }
  }

  // Start delay
  if (process.env.LOCALBOT_HEARTBEAT_START_DELAY) {
    const delay = parseInt(process.env.LOCALBOT_HEARTBEAT_START_DELAY, 10);
    if (!isNaN(delay) && delay >= 0) {
      config.startDelay = delay;
    }
  }

  return config;
}

/**
 * Validate heartbeat config
 */
export function validateHeartbeatConfig(config: HeartbeatConfig): string[] {
  const errors: string[] = [];

  if (config.every <= 0) {
    errors.push('Heartbeat interval must be positive');
  }

  if (config.every < 1) {
    errors.push('Heartbeat interval must be at least 1 minute');
  }

  if (!config.prompt || config.prompt.trim().length === 0) {
    errors.push('Heartbeat prompt cannot be empty');
  }

  if (config.ackMaxChars <= 0) {
    errors.push('ackMaxChars must be positive');
  }

  return errors;
}
