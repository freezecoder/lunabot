/**
 * Utility functions for LocalBot Dashboard
 */

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes, decimals = 1) {
  if (bytes === 0 || bytes === undefined || bytes === null) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Format duration in milliseconds
 */
export function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format relative time
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp) return 'never';

  const now = Date.now();
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diff = now - time;

  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 5) return `${seconds}s ago`;
  return 'just now';
}

/**
 * Format timestamp to time string
 */
export function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Format timestamp to date string
 */
export function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Format timestamp to full datetime
 */
export function formatDateTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format number with commas
 */
export function formatNumber(num) {
  if (num === undefined || num === null) return '0';
  return num.toLocaleString();
}

/**
 * Format percentage
 */
export function formatPercent(value, decimals = 1) {
  if (value === undefined || value === null) return '0%';
  return `${value.toFixed(decimals)}%`;
}

/**
 * Truncate string
 */
export function truncate(str, maxLength = 50) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Capitalize first letter
 */
export function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Debounce function
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Activity type icons
 */
export const activityIcons = {
  message: '💬',
  tool_call: '🔧',
  error: '❌',
  attachment: '📎',
  system: '⚙️',
};

/**
 * Activity source labels
 */
export const sourceLabels = {
  terminal: 'Terminal',
  telegram: 'Telegram',
};

/**
 * Service status colors (CSS class names)
 */
export const statusColors = {
  running: 'success',
  stopped: '',
  error: 'error',
  starting: 'warning',
};

/**
 * Get progress bar color based on value
 */
export function getProgressColor(percent) {
  if (percent >= 90) return 'error';
  if (percent >= 70) return 'warning';
  return '';
}

/**
 * Safely parse JSON
 */
export function safeParseJSON(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Check if object is empty
 */
export function isEmpty(obj) {
  if (!obj) return true;
  if (Array.isArray(obj)) return obj.length === 0;
  return Object.keys(obj).length === 0;
}

/**
 * Create element class string
 */
export function classNames(...args) {
  return args
    .flat()
    .filter(Boolean)
    .join(' ');
}
