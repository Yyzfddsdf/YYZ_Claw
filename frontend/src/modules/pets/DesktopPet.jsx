import { useEffect, useMemo, useRef, useState } from "react";

import "./desktop-pet.css";

const DEFAULT_MANIFEST = {
  sprite: {
    columns: 8,
    rows: 9,
    totalFrames: 72,
    frameWidth: 128,
    frameHeight: 128,
    rowStates: [
      { row: 0, state: "idle", label: "待机", frames: [0, 1, 2, 3, 4, 5], durations: [280, 110, 110, 140, 140, 320] },
      { row: 1, state: "running-right", label: "向右跑动", frames: [0, 1, 2, 3, 4, 5, 6, 7], durations: [120, 120, 120, 120, 120, 120, 120, 220] },
      { row: 2, state: "running-left", label: "向左跑动", frames: [0, 1, 2, 3, 4, 5, 6, 7], durations: [120, 120, 120, 120, 120, 120, 120, 220] },
      { row: 3, state: "waving", label: "挥手", frames: [0, 1, 2, 3], durations: [140, 140, 140, 280] },
      { row: 4, state: "jumping", label: "跳跃", frames: [0, 1, 2, 3, 4], durations: [140, 140, 140, 140, 280] },
      { row: 6, state: "waiting", label: "等待", frames: [0, 1, 2, 3, 4, 5], durations: [150, 150, 150, 150, 150, 260] },
      { row: 7, state: "running", label: "干活中", frames: [0, 1, 2, 3, 4, 5], durations: [120, 120, 120, 120, 120, 220] }
    ]
  }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeManifest(manifest) {
  const sprite = manifest?.sprite ?? DEFAULT_MANIFEST.sprite;
  const rowStates =
    Array.isArray(sprite?.rowStates) && sprite.rowStates.length > 0
      ? sprite.rowStates
      : DEFAULT_MANIFEST.sprite.rowStates;
  return {
    sprite: {
      columns: Number(sprite?.columns) || 8,
      rows: Number(sprite?.rows) || 9,
      totalFrames: Number(sprite?.totalFrames) || 72,
      frameWidth: Number(sprite?.frameWidth) || 128,
      frameHeight: Number(sprite?.frameHeight) || 128,
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
  const frames = useMemo(
    () => (Array.isArray(rowConfig?.frames) && rowConfig.frames.length > 0 ? rowConfig.frames : [0]),
    [rowConfig]
  );
  const durations = useMemo(
    () =>
      Array.isArray(rowConfig?.durations) && rowConfig.durations.length > 0
        ? rowConfig.durations
        : [160],
    [rowConfig]
  );
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
  }, [frames.length, state]);

  useEffect(() => {
    if (frames.length <= 1) {
      return undefined;
    }
    const duration = durations[frameIndex] ?? durations[durations.length - 1] ?? 160;
    const timer = window.setTimeout(() => {
      setFrameIndex((previous) => (previous + 1) % frames.length);
    }, Math.max(80, duration));
    return () => window.clearTimeout(timer);
  }, [durations, frameIndex, frames.length]);

  return {
    columnIndex: frames[frameIndex] ?? frames[0] ?? 0,
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
  const [transientState, setTransientState] = useState("");
  const [position, setPosition] = useState(() => ({
    x: Number(settings?.detachedPosition?.x) || 80,
    y: Number(settings?.detachedPosition?.y) || 80
  }));
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const dragDirectionRef = useRef("running-right");
  const specialTimerRef = useRef(null);
  const clearTimerRef = useRef(null);

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

  useEffect(() => {
    if (specialTimerRef.current) {
      window.clearTimeout(specialTimerRef.current);
      specialTimerRef.current = null;
    }
    if (clearTimerRef.current) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    if (dragging || active) {
      setTransientState("");
      return undefined;
    }

    let cancelled = false;
    const scheduleSpecial = () => {
      specialTimerRef.current = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        const nextState = Math.random() < 0.5 ? "waving" : "jumping";
        setTransientState(nextState);
        clearTimerRef.current = window.setTimeout(() => {
          if (cancelled) {
            return;
          }
          setTransientState("");
          scheduleSpecial();
        }, 1200);
      }, hovered ? 3200 + Math.floor(Math.random() * 2600) : 5200 + Math.floor(Math.random() * 4200));
    };

    scheduleSpecial();
    return () => {
      cancelled = true;
      if (specialTimerRef.current) {
        window.clearTimeout(specialTimerRef.current);
        specialTimerRef.current = null;
      }
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, [active, dragging, hovered]);

  const activeState = dragging
    ? dragDirectionRef.current
    : active
      ? "running"
      : transientState || (hovered ? "waiting" : "idle");

  const spriteClock = useSpriteClock(activeState, normalizedManifest);

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
      const currentX = detachedWindow ? event.screenX : event.clientX;
      const currentY = detachedWindow ? event.screenY : event.clientY;
      const dx = currentX - lastPointerRef.current.x;
      const dy = currentY - lastPointerRef.current.y;
      lastPointerRef.current = { x: currentX, y: currentY };

      if (Math.abs(dx) > 2) {
        dragDirectionRef.current = dx >= 0 ? "running-right" : "running-left";
      }

      if (detachedWindow) {
        if (window.yyzClaw?.dragPetWindow) {
          window.yyzClaw.dragPetWindow({ dx, dy });
        }
        return;
      }

      const nextX = Math.round(event.clientX - dragOffsetRef.current.x);
      const nextY = Math.round(event.clientY - dragOffsetRef.current.y);
      setPosition({
        x: nextX,
        y: nextY
      });
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

  const columns = Math.max(1, Number(normalizedManifest.sprite.columns) || 8);
  const rows = Math.max(1, Number(normalizedManifest.sprite.rows) || 9);
  const frameWidth = Math.max(1, Number(normalizedManifest.sprite.frameWidth) || 128);
  const frameHeight = Math.max(1, Number(normalizedManifest.sprite.frameHeight) || 128);
  const spriteWidthPercent = `${columns * 100}%`;
  const spriteHeightPercent = `${rows * 100}%`;
  const backgroundPositionX = `${(spriteClock.columnIndex / Math.max(1, columns - 1)) * 100}%`;
  const backgroundPositionY = `${(spriteClock.rowIndex / Math.max(1, rows - 1)) * 100}%`;

  return (
    <div
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
          lastPointerRef.current = {
            x: detachedWindow ? event.screenX : event.clientX,
            y: detachedWindow ? event.screenY : event.clientY
          };
          setDragging(true);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={selectedPet.displayName || selectedPet.name}
        aria-label={`桌宠 ${selectedPet.displayName || selectedPet.name}`}
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
        {!detachedWindow ? <span className="desktop-pet-name">{selectedPet.displayName || selectedPet.name}</span> : null}
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
