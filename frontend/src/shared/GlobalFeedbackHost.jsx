import { useEffect, useState } from "react";

import {
  dismissNotice,
  resolveConfirm,
  subscribeFeedback
} from "./feedback";
import "./global-feedback.css";

export function GlobalFeedbackHost() {
  const [state, setState] = useState({
    notices: [],
    confirm: null
  });

  useEffect(() => subscribeFeedback(setState), []);

  const confirm = state.confirm;

  return (
    <>
      <div className="global-feedback-stack" aria-live="polite">
        {state.notices.map((notice) => (
          <article
            key={notice.id}
            className={`global-toast global-toast-${notice.tone || "info"}`}
          >
            <div className="global-toast-mark" aria-hidden="true" />
            <div className="global-toast-copy">
              {notice.title ? <strong>{notice.title}</strong> : null}
              <p>{notice.message}</p>
            </div>
            <button
              type="button"
              className="global-toast-close"
              onClick={() => dismissNotice(notice.id)}
              aria-label="关闭提醒"
            >
              x
            </button>
          </article>
        ))}
      </div>

      {confirm ? (
        <div
          className="global-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              resolveConfirm(false);
            }
          }}
        >
          <section
            className={`global-confirm global-confirm-${confirm.tone || "danger"}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-confirm-title"
          >
            <div className="global-confirm-orb" aria-hidden="true" />
            <div className="global-confirm-copy">
              <h2 id="global-confirm-title">{confirm.title}</h2>
              {confirm.message ? <p>{confirm.message}</p> : null}
              {confirm.detail ? <small>{confirm.detail}</small> : null}
            </div>
            <div className="global-confirm-actions">
              <button
                type="button"
                className="global-confirm-cancel"
                onClick={() => resolveConfirm(false)}
              >
                {confirm.cancelLabel}
              </button>
              <button
                type="button"
                className="global-confirm-accept"
                onClick={() => resolveConfirm(true)}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
