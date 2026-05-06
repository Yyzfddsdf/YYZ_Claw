import { useEffect, useMemo, useRef, useState } from "react";

import "./desktop-pet.css";

const DEFAULT_MANIFEST = {
  sprite: {
    columns: 4,
    rows: 4,
    totalFrames: 16,
    rowStates: [
      { row: 0, state: "idle", label: "空闲", frames: [0, 1, 2, 3], fps: 4 },
      { row: 1, state: "active", label: "活跃", frames: [4, 5, 6, 7], fps: 6 },
      { row: 2, state: "hover", label: "悬停", frames: [8, 9, 10, 11], fps: 5 },
      { row: 3, state: "detached", label: "拖出窗口", frames: [12, 13, 14, 15], fps: 6 }
    ]
  }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeManifest(manifest) {
  const sprite = manifest?.sprite ?? DEFAULT_MANIFEST.sprite;
  const rowStates = Array.isArray(sprite?.rowStates) && sprite.rowStates.length > 0
    ? sprite.rowStates
    : DEFAULT_MANIFEST.sprite.rowStates;
  return {
    sprite: {
      columns: Number(sprite?.columns) || 4,
      rows: Number(sprite?.rows) || 4,
      totalFrames: Number(sprite?.totalFrames) || 16,
      frameWidth: Number(sprite?.frameWidth) || 0,
      frameHeight: Number(sprite?.frameHeight) || 0,
      rowStates
    }
  };
}

function resolveRowConfig(manifest, state) {
  const rowStates = normalizeManifest(manifest).sprite.rowStates;
  return rowStates.find((item) => item.state === state) ?? rowStates[0];
}

function useSpriteClock(state, manifest) {
  const rowConfig = useMemo(() => resolveRowConfig(manifest, state), [manifest, state]);
  const frames = Array.isArray(rowConfig?.frames) && rowConfig.frames.length > 0 ? rowConfig.frames : [0, 1, 2, 3];
  const fps = Number(rowConfig?.fps) > 0 ? Number(rowConfig.fps) : 4;
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
    const timer = window.setInterval(() => {
      setFrameIndex((previous) => (previous + 1) % frames.length);
    }, Math.max(80, Math.round(1000 / fps)));
    return () => window.clearInterval(timer);
  }, [fps, frames.length, state]);

  return {
    columnIndex: frameIndex % frames.length,
    rowIndex: Number(rowConfig?.row) || 0
  };
}

export function DesktopPet({
  pets = [],
  settings = {},
  manifest = DEFAULT_MANIFEST,
  active = false,
  activeSessions = [],
  onSettingsChange,
  detachedWindow = false
}) {
  const normalizedManifest = useMemo(() => normalizeManifest(manifest), [manifest]);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [position, setPosition] = useState(() => ({
    x: Number(settings?.detachedPosition?.x) || 80,
    y: Number(settings?.detachedPosition?.y) || 80
  }));
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const lastScreenPointRef = useRef({ x: 0, y: 0 });
  const hostRef = useRef(null);

  useEffect(() => {
    setPosition({
      x: Number(settings?.detachedPosition?.x) || 80,
      y: Number(settings?.detachedPosition?.y) || 80
    });
  }, [settings?.detachedPosition?.x, settings?.detachedPosition?.y]);

  const selectedPet = useMemo(() => {
    const preferred = String(settings?.selectedPet ?? "").trim();
    return (
      pets.find((item) => item.fileName === preferred) ??
      pets.find((item) => item.source === "user") ??
      pets[0] ??
      null
    );
  }, [pets, settings?.selectedPet]);
  const visibleActiveSessions = useMemo(
    () =>
      (Array.isArray(activeSessions) ? activeSessions : [])
        .map((item) => ({
          conversationId: String(item?.conversationId ?? "").trim(),
          title: String(item?.title ?? "").trim()
        }))
        .filter((item) => item.conversationId && item.title)
        .slice(0, 3),
    [activeSessions]
  );

  const activeState = dragging ? "detached" : hovered ? "hover" : active ? "active" : "idle";
  const spriteClock = useSpriteClock(activeState, normalizedManifest);

  useEffect(() => {
    if (!selectedPet?.url) {
      setImageSize({ width: 0, height: 0 });
      return undefined;
    }
    const image = new Image();
    image.onload = () => {
      setImageSize({
        width: Number(image.naturalWidth) || 0,
        height: Number(image.naturalHeight) || 0
      });
    };
    image.src = selectedPet.url;
    return () => {
      image.onload = null;
    };
  }, [selectedPet?.url]);

  useEffect(() => {
    if (!selectedPet && pets.length > 0) {
      onSettingsChange?.({
        ...settings,
        selectedPet: pets[0].fileName
      });
    }
  }, [onSettingsChange, pets, selectedPet, settings]);

  useEffect(() => {
    if (!dragging) {
      return undefined;
    }

    function handlePointerMove(event) {
      if (detachedWindow) {
        const dx = event.screenX - lastScreenPointRef.current.x;
        const dy = event.screenY - lastScreenPointRef.current.y;
        lastScreenPointRef.current = {
          x: event.screenX,
          y: event.screenY
        };
        if (window.yyzClaw?.dragPetWindow) {
          window.yyzClaw.dragPetWindow({ dx, dy });
        }
        return;
      }

      const nextX = detachedWindow
        ? Math.round(event.screenX - dragOffsetRef.current.x)
        : Math.round(event.clientX - dragOffsetRef.current.x);
      const nextY = detachedWindow
        ? Math.round(event.screenY - dragOffsetRef.current.y)
        : Math.round(event.clientY - dragOffsetRef.current.y);
      setPosition({
        x: nextX,
        y: nextY
      });
      if (detachedWindow && window.yyzClaw?.movePetWindow) {
        window.yyzClaw.movePetWindow({
          x: nextX,
          y: nextY
        });
      }
    }

    function handlePointerUp() {
      setDragging(false);
      const nextX = Math.round(position.x);
      const nextY = Math.round(position.y);

      if (detachedWindow) {
        onSettingsChange?.({
          ...settings,
          detached: true,
          detachedPosition: {
            x: nextX,
            y: nextY
          }
        });
        return;
      }

      const outsideMainViewport =
        nextX < 0 || nextY < 0 || nextX + 128 > window.innerWidth || nextY + 128 > window.innerHeight;

      if (!detachedWindow && outsideMainViewport && window.yyzClaw?.openPetWindow && selectedPet?.fileName) {
        window.yyzClaw.openPetWindow({
          selectedPet: selectedPet.fileName,
          x: window.screenX + nextX,
          y: window.screenY + nextY
        });
      }

      if (detachedWindow && window.yyzClaw?.movePetWindow) {
        window.yyzClaw.movePetWindow({
          x: nextX,
          y: nextY
        });
      }

      onSettingsChange?.({
        ...settings,
        detached: true,
        detachedPosition: {
          x: nextX,
          y: nextY
        }
      });
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [detachedWindow, dragging, onSettingsChange, position.x, position.y, selectedPet?.fileName, settings]);

  if (!selectedPet) {
    return null;
  }

  const columns = Math.max(1, Number(normalizedManifest.sprite.columns) || 4);
  const rows = Math.max(1, Number(normalizedManifest.sprite.rows) || 4);
  const spriteFrameWidth =
    Number(normalizedManifest.sprite.frameWidth) ||
    (imageSize.width > 0 ? Math.round(imageSize.width / columns) : 96);
  const spriteFrameHeight =
    Number(normalizedManifest.sprite.frameHeight) ||
    (imageSize.height > 0 ? Math.round(imageSize.height / rows) : 96);
  const frameWidth = 128;
  const frameHeight = 128;
  const spriteWidthPercent = `${columns * 100}%`;
  const spriteHeightPercent = `${rows * 100}%`;
  const backgroundPositionX = `${(spriteClock.columnIndex / Math.max(1, columns - 1)) * 100}%`;
  const backgroundPositionY = `${(spriteClock.rowIndex / Math.max(1, rows - 1)) * 100}%`;

  return (
    <div
      ref={hostRef}
      className={`desktop-pet ${dragging ? "is-dragging" : ""} ${
        detachedWindow ? "is-detached-window" : ""
      }`}
      style={{
        left: `${detachedWindow ? 0 : clamp(position.x, -frameWidth / 2, window.innerWidth - 24)}px`,
        top: `${detachedWindow ? 0 : clamp(position.y, 24, window.innerHeight - 24)}px`
      }}
    >
      <button
        type="button"
        className="desktop-pet-button"
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          dragOffsetRef.current = {
            x: detachedWindow ? event.screenX - window.screenX : event.clientX - rect.left,
            y: detachedWindow ? event.screenY - window.screenY : event.clientY - rect.top
          };
          lastScreenPointRef.current = {
            x: event.screenX,
            y: event.screenY
          };
          setDragging(true);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={selectedPet.name}
        aria-label={`桌宠 ${selectedPet.name}`}
      >
        <span
          className="desktop-pet-sprite"
          style={{
            width: `${frameWidth}px`,
            height: `${frameHeight}px`,
            backgroundImage: `url("${selectedPet.url}")`,
            backgroundSize: `${spriteWidthPercent} ${spriteHeightPercent}`,
            backgroundPosition: `${backgroundPositionX} ${backgroundPositionY}`,
            backgroundRepeat: "no-repeat"
          }}
        />
        {!detachedWindow ? <span className="desktop-pet-name">{selectedPet.name}</span> : null}
      </button>
      {detachedWindow && visibleActiveSessions.length > 0 ? (
        <div className="desktop-pet-bubbles" aria-label="活跃会话">
          {visibleActiveSessions.map((session, index) => (
            <button
              key={`${session.conversationId}-${index}`}
              type="button"
              className="desktop-pet-bubble"
              title={session.title}
              onClick={() => {
                window.yyzClaw?.openPetConversation?.(session.conversationId);
              }}
            >
              {session.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
