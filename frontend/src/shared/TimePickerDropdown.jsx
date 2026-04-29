import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./time-picker-dropdown.css";

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

function normalizeTime(value) {
  const normalized = String(value ?? "").trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
    return "09:00";
  }
  return normalized;
}

function OptionColumn({
  options,
  selected,
  onSelect,
  label,
  disabled = false
}) {
  return (
    <div className="tpd-column" role="listbox" aria-label={label}>
      {options.map((item) => {
        const isActive = item === selected;
        return (
          <button
            key={`${label}_${item}`}
            type="button"
            role="option"
            aria-selected={isActive}
            className={`tpd-option ${isActive ? "is-active" : ""}`}
            onClick={() => onSelect(item)}
            disabled={disabled}
          >
            {item}
          </button>
        );
      })}
    </div>
  );
}

export function TimePickerDropdown({
  value = "09:00",
  onChange,
  disabled = false,
  ariaLabel = "时间选择"
}) {
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState(null);
  const rootRef = useRef(null);
  const popoverRef = useRef(null);
  const normalized = useMemo(() => normalizeTime(value), [value]);
  const [hour, minute] = normalized.split(":");

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (
        !rootRef.current?.contains(event.target) &&
        !popoverRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverStyle(null);
      return undefined;
    }

    let frameId = 0;

    function updatePosition() {
      const trigger = rootRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) {
        return;
      }

      const viewportPadding = 12;
      const triggerRect = trigger.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const popoverWidth = popoverRect.width || 170;
      const popoverHeight = popoverRect.height || 238;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const spaceBelow = viewportHeight - triggerRect.bottom - viewportPadding;
      const spaceAbove = triggerRect.top - viewportPadding;
      const shouldOpenAbove = spaceBelow < popoverHeight && spaceAbove > spaceBelow;
      const availableHeight = Math.max(
        120,
        shouldOpenAbove ? spaceAbove - 8 : spaceBelow - 8
      );

      const preferredLeft = triggerRect.left;
      const maxLeft = viewportWidth - popoverWidth - viewportPadding;
      const left = Math.max(viewportPadding, Math.min(preferredLeft, maxLeft));
      const top = shouldOpenAbove
        ? Math.max(viewportPadding, triggerRect.top - Math.min(popoverHeight, availableHeight) - 8)
        : Math.min(viewportHeight - viewportPadding, triggerRect.bottom + 8);

      setPopoverStyle({
        left,
        top,
        maxHeight: Math.min(220, availableHeight),
        visibility: "visible"
      });
    }

    function scheduleUpdate() {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updatePosition);
    }

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [open]);

  function commit(nextHour, nextMinute) {
    if (typeof onChange !== "function") {
      return;
    }

    const normalizedHour = HOUR_OPTIONS.includes(String(nextHour)) ? String(nextHour) : hour;
    const normalizedMinute = MINUTE_OPTIONS.includes(String(nextMinute)) ? String(nextMinute) : minute;
    onChange(`${normalizedHour}:${normalizedMinute}`);
  }

  return (
    <div className={`tpd-root ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="tpd-trigger"
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className="tpd-trigger-value">{hour}</span>
        <span className="tpd-trigger-separator">:</span>
        <span className="tpd-trigger-value">{minute}</span>
      </button>

      {open ? createPortal(
        <div
          className="tpd-popover"
          role="dialog"
          aria-label={ariaLabel}
          ref={popoverRef}
          style={popoverStyle ?? { visibility: "hidden" }}
        >
          <OptionColumn
            options={HOUR_OPTIONS}
            selected={hour}
            onSelect={(nextHour) => commit(nextHour, minute)}
            label="小时"
            disabled={disabled}
          />
          <div className="tpd-mid-separator">:</div>
          <OptionColumn
            options={MINUTE_OPTIONS}
            selected={minute}
            onSelect={(nextMinute) => commit(hour, nextMinute)}
            label="分钟"
            disabled={disabled}
          />
        </div>,
        document.body
      ) : null}
    </div>
  );
}
