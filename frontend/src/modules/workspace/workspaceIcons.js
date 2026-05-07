const ICONS = {
  add: [
    <path key="h" d="M12 5v14" />,
    <path key="v" d="M5 12h14" />
  ],
  minus: [
    <path key="m" d="M5 12h14" />
  ],
  branch: [
    <path key="stem" d="M7 5v8c0 1.66-1.34 3-3 3" />,
    <path key="fork" d="M7 5c0 1.66 1.34 3 3 3h4c1.66 0 3 1.34 3 3v8" />,
    <circle key="top" cx="7" cy="5" r="1.5" />,
    <circle key="mid" cx="7" cy="13" r="1.5" />,
    <circle key="bottom" cx="17" cy="19" r="1.5" />
  ],
  close: [
    <path key="a" d="M6 6l12 12" />,
    <path key="b" d="M18 6L6 18" />
  ],
  commit: [
    <path key="a" d="M5 12l4 4L19 6" />
  ],
  file: [
    <path key="a" d="M7 3h6l4 4v14H7z" />,
    <path key="b" d="M13 3v5h5" />
  ],
  git: [
    <circle key="a" cx="7" cy="6" r="1.5" />,
    <circle key="b" cx="7" cy="18" r="1.5" />,
    <circle key="c" cx="17" cy="12" r="1.5" />,
    <path key="d" d="M7 7v9" />,
    <path key="e" d="M8.5 6h4.5c2.2 0 4 1.8 4 4v2" />,
    <path key="f" d="M12 12h3" />
  ],
  refresh: [
    <path key="a" d="M19 7v5h-5" />,
    <path key="b" d="M5 17v-5h5" />,
    <path key="c" d="M18.4 9A7 7 0 0 0 6 6.5" />,
    <path key="d" d="M5.6 15A7 7 0 0 0 18 17.5" />
  ],
  revert: [
    <path key="a" d="M8 8H4v4" />,
    <path key="b" d="M4 12a8 8 0 1 0 2.2-5.6L4 8" />
  ],
  save: [
    <path key="a" d="M5 4h11l3 3v13H5z" />,
    <path key="b" d="M8 4v6h8V4" />,
    <path key="c" d="M9 20v-6h6v6" />
  ],
  spark: [
    <path key="a" d="M12 4l1.8 4.2L18 10l-4.2 1.8L12 16l-1.8-4.2L6 10l4.2-1.8z" />
  ],
  stage: [
    <path key="a" d="M6 6h12v12H6z" />,
    <path key="b" d="M9 12h6" />,
    <path key="c" d="M12 9v6" />
  ],
  terminal: [
    <path key="a" d="M5 6h14v12H5z" />,
    <path key="b" d="M8 10l3 2-3 2" />,
    <path key="c" d="M13 14h4" />
  ],
  tree: [
    <path key="a" d="M7 5v14" />,
    <path key="b" d="M7 9h5" />,
    <path key="c" d="M12 9a3 3 0 1 0 0-6" />,
    <path key="d" d="M12 15h5" />,
    <path key="e" d="M12 15a3 3 0 1 0 0 6" />,
    <circle key="f" cx="7" cy="5" r="1.5" />,
    <circle key="g" cx="17" cy="9" r="1.5" />,
    <circle key="h" cx="17" cy="15" r="1.5" />
  ],
  window: [
    <path key="a" d="M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />,
    <path key="b" d="M9 15l6-6" />,
    <path key="c" d="M11 9h4v4" />
  ]
};

export function WorkspaceIcon({ name, className = "", title = "", ...props }) {
  const iconPaths = ICONS[name] ?? ICONS.file;

  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {iconPaths}
      {title ? <title>{title}</title> : null}
    </svg>
  );
}

export function WorkspaceIconButton({
  icon,
  label,
  className = "",
  active = false,
  disabled = false,
  type = "button",
  ...props
}) {
  return (
    <button
      type={type}
      className={`workspace-icon-button ${active ? "is-active" : ""} ${className}`.trim()}
      aria-label={label}
      title={label}
      disabled={disabled}
      {...props}
    >
      <WorkspaceIcon name={icon} />
    </button>
  );
}
