import { useMemo, useState } from "react";

import { savePetSettings } from "../../api/petsApi";
import { notify } from "../../shared/feedback";
import "./pets.css";

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

export function PetPanel({ petState, onPetStateChange }) {
  const [busy, setBusy] = useState(false);
  const pets = Array.isArray(petState?.pets) ? petState.pets : [];
  const settings = petState?.settings ?? { selectedPet: "" };
  const manifest = petState?.manifest ?? null;

  const selectedPet = useMemo(
    () => pets.find((item) => item.fileName === settings.selectedPet) ?? pets[0] ?? null,
    [pets, settings.selectedPet]
  );

  async function handleSelect(fileName) {
    setBusy(true);
    try {
      const response = await savePetSettings({
        ...settings,
        selectedPet: fileName
      });
      if (settings.enabled !== false && window.yyzClaw?.openPetWindow) {
        window.yyzClaw.openPetWindow({
          selectedPet: fileName
        });
      }
      onPetStateChange?.({
        pets: response?.pets ?? pets,
        settings: response?.settings ?? settings,
        manifest: response?.manifest ?? manifest
      });
      notify({
        tone: "success",
        title: "桌宠已切换",
        message: fileName || "已清空选择"
      });
    } catch (error) {
      notify({
        tone: "danger",
        title: "切换桌宠失败",
        message: error.message || "无法保存桌宠设置"
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleEnabledChange(enabled) {
    setBusy(true);
    try {
      const response = await savePetSettings({
        ...settings,
        enabled
      });
      if (enabled) {
        window.yyzClaw?.openPetWindow?.({
          selectedPet: settings.selectedPet || selectedPet?.fileName || ""
        });
      } else {
        window.yyzClaw?.closePetWindow?.();
      }
      onPetStateChange?.({
        pets: response?.pets ?? pets,
        settings: response?.settings ?? settings,
        manifest: response?.manifest ?? manifest
      });
      notify({
        tone: "success",
        title: enabled ? "桌宠已开启" : "桌宠已关闭",
        message: selectedPet?.name ?? "桌宠设置已保存"
      });
    } catch (error) {
      notify({
        tone: "danger",
        title: "桌宠开关保存失败",
        message: error.message || "无法保存桌宠设置"
      });
    } finally {
      setBusy(false);
    }
  }

  const frameWidth = Number(manifest?.sprite?.frameWidth) || 256;
  const frameHeight = Number(manifest?.sprite?.frameHeight) || 256;

  return (
    <div className="pet-panel">
      <header className="pet-panel-hero">
        <div>
          <p className="pet-panel-kicker">Desktop Pet</p>
          <h2>桌宠切换</h2>
        </div>
        <div className="pet-panel-summary">
          <span>当前桌宠</span>
          <strong>{selectedPet?.name ?? "未选择"}</strong>
          <small>{pets.length} 个可用宠物</small>
          <button
            type="button"
            className={`pet-enable-toggle ${settings.enabled === false ? "" : "is-on"}`}
            disabled={busy}
            onClick={() => handleEnabledChange(settings.enabled === false)}
          >
            {settings.enabled === false ? "开启桌宠" : "关闭桌宠"}
          </button>
        </div>
      </header>

      <section className="pet-panel-grid" aria-label="pet gallery">
        {pets.map((pet) => {
          const isSelected = settings.selectedPet === pet.fileName;
          return (
            <article key={pet.fileName} className={`pet-card ${isSelected ? "is-selected" : ""}`}>
              <button
                type="button"
                className="pet-card-preview"
                disabled={busy}
                onClick={() => handleSelect(pet.fileName)}
                aria-label={`选择桌宠 ${pet.name}`}
              >
                <span
                  className="pet-card-sprite"
                  style={{
                    width: `${frameWidth}px`,
                    height: `${frameHeight}px`,
                    backgroundImage: `url("${pet.url}")`,
                    backgroundSize: "400% 400%",
                    backgroundPosition: "0% 0%"
                  }}
                />
                <span className="pet-card-badge">{isSelected ? "当前使用" : pet.source === "default" ? "默认资产" : "用户宠物"}</span>
              </button>
              <div className="pet-card-meta">
                <div>
                  <strong title={pet.name}>{pet.name}</strong>
                  <small>{formatFileSize(pet.size)} · {pet.source}</small>
                </div>
                <button
                  type="button"
                  className="pet-card-select"
                  disabled={busy || isSelected}
                  onClick={() => handleSelect(pet.fileName)}
                >
                  {isSelected ? "已选择" : "使用"}
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
