/**
 * Debounce: delays invoking fn until after `delay` ms have elapsed
 * since the last invocation.
 */
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Format a date string (YYYY-MM-DD or ISO) to a locale-friendly string.
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    // Show time if ISO format with time component
    if (dateStr.includes('T')) {
      return d.toLocaleString('ja-JP', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    }
    return d.toLocaleDateString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Parse window.location.hash into { route, param }.
 * Patterns:
 *   #/experiments        -> { route: 'experiments', param: null }
 *   #/experiment/abc-123 -> { route: 'experiment', param: 'abc-123' }
 *   (empty)              -> { route: 'experiments', param: null }
 */
function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash) return { route: 'experiments', param: null };
  const parts = hash.split('/');
  return {
    route: parts[0] || 'experiments',
    param: parts.slice(1).join('/') || null,
  };
}
