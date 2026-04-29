import { useMemo, useRef, useState } from "react";

import {
  deleteBackground,
  saveBackgroundSettings,
  uploadBackground
} from "../../api/backgroundApi";
import { confirmAction, notify } from "../../shared/feedback";
import "./backgrounds.css";

const ACCEPTED_IMAGE_TYPES = ".png,.jpg,.jpeg,.webp,.gif,.avif,.svg,image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml";

function formatFileSize(size) {
  const value = Number(size ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "未知大小";
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.ceil(value / 1024)} KB`;
}

export function BackgroundPanel({ appearance, onAppearanceChange }) {
  const fileInputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const backgrounds = Array.isArray(appearance?.backgrounds) ? appearance.backgrounds : [];
  const settings = appearance?.settings ?? { selectedFile: "", surfaceOpacity: 0.68 };
  const selectedBackground = useMemo(
    () => backgrounds.find((item) => item.name === settings.selectedFile) ?? null,
    [backgrounds, settings.selectedFile]
  );

  async function updateFromResponse(response) {
    onAppearanceChange?.({
      backgrounds: response?.backgrounds ?? backgrounds,
      settings: response?.settings ?? settings
    });
  }

  async function handleSelect(fileName) {
    setBusy(true);
    try {
      await updateFromResponse(
        await saveBackgroundSettings({
          ...settings,
          selectedFile: fileName
        })
      );
    } catch (error) {
      notify({
        tone: "danger",
        title: "背景切换失败",
        message: error.message || "无法保存背景设置"
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleOpacityChange(event) {
    const surfaceOpacity = Number(event.target.value);
    onAppearanceChange?.({
      backgrounds,
      settings: {
        ...settings,
        surfaceOpacity
      }
    });
  }

  async function handleOpacityCommit(event) {
    const surfaceOpacity = Number(event.target.value);
    setBusy(true);
    try {
      await updateFromResponse(
        await saveBackgroundSettings({
          ...settings,
          surfaceOpacity
        })
      );
    } catch (error) {
      notify({
        tone: "danger",
        title: "透明度保存失败",
        message: error.message || "无法保存界面透明度"
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }

    setBusy(true);
    try {
      const response = await uploadBackground(file);
      await updateFromResponse(response);
      notify({
        tone: "success",
        title: "背景已上传",
        message: response?.background?.name || file.name
      });
    } catch (error) {
      notify({
        tone: "danger",
        title: "上传失败",
        message: error.message || "仅支持常见图片格式"
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(fileName) {
    const confirmed = await confirmAction({
      title: "删除背景图",
      message: `确认删除 ${fileName}？删除后不会影响其它图片。`,
      confirmLabel: "删除",
      tone: "danger"
    });
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      await updateFromResponse(await deleteBackground(fileName));
      notify({
        tone: "success",
        title: "背景已删除",
        message: fileName
      });
    } catch (error) {
      notify({
        tone: "danger",
        title: "删除失败",
        message: error.message || "无法删除背景图"
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="background-module">
      <header className="background-hero">
        <div>
          <p className="background-kicker">Appearance</p>
          <h2>界面背景</h2>
          <p>背景图保存在 .yyz/backgrounds，内置图和上传图都只是普通资产。</p>
        </div>
        <div className="background-actions">
          <button
            type="button"
            className="background-upload-button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            上传背景图
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            onChange={handleUpload}
            hidden
          />
        </div>
      </header>

      <section className="background-control-strip">
        <div>
          <span className="background-control-label">当前背景</span>
          <strong>{selectedBackground?.name ?? "未启用"}</strong>
        </div>
        <label className="background-opacity-control">
          <span>界面不透明度</span>
          <input
            type="range"
            min="0.18"
            max="0.98"
            step="0.01"
            value={Number(settings.surfaceOpacity ?? 0.68)}
            onChange={handleOpacityChange}
            onBlur={handleOpacityCommit}
            onMouseUp={handleOpacityCommit}
            onTouchEnd={handleOpacityCommit}
            disabled={busy}
          />
          <b>{Math.round(Number(settings.surfaceOpacity ?? 0.68) * 100)}%</b>
        </label>
      </section>

      <section className="background-grid" aria-label="background gallery">
        <button
          type="button"
          className={`background-card background-card-none ${!settings.selectedFile ? "is-selected" : ""}`}
          disabled={busy}
          onClick={() => handleSelect("")}
        >
          <span className="background-none-orb" />
          <strong>不使用背景图</strong>
          <small>恢复默认浅色界面</small>
        </button>

        {backgrounds.map((background) => (
          <article
            key={background.name}
            className={`background-card ${settings.selectedFile === background.name ? "is-selected" : ""}`}
          >
            <button
              type="button"
              className="background-preview"
              disabled={busy}
              onClick={() => handleSelect(background.name)}
              aria-label={`选择背景 ${background.name}`}
            >
              <img src={background.url} alt={background.name} />
              <span className="background-selected-badge">已启用</span>
            </button>
            <div className="background-card-meta">
              <div>
                <strong title={background.name}>{background.name}</strong>
                <small>{formatFileSize(background.size)} · {background.mimeType}</small>
              </div>
              <button
                type="button"
                className="background-delete-button"
                disabled={busy}
                onClick={() => handleDelete(background.name)}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
