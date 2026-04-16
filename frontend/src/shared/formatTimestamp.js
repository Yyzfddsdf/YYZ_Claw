export function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false
  });
}
