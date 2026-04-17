export function MemoryActionDock({
  loading,
  busy,
  onBack,
  onRefresh,
  onResetViewport
}) {
  const isDisabled = Boolean(loading || busy);

  return (
    <div className="memory-action-dock">
      <button
        type="button"
        className="memory-dock-button"
        onClick={onBack}
      >
        返回会话
      </button>
      <button
        type="button"
        className="memory-dock-button"
        onClick={onRefresh}
        disabled={isDisabled}
      >
        {loading ? "刷新中..." : "全局刷新"}
      </button>
      <button
        type="button"
        className="memory-dock-button"
        onClick={onResetViewport}
        disabled={loading}
      >
        归中视图
      </button>
    </div>
  );
}
