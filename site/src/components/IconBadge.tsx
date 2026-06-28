type IconBadgeProps = {
  icon: string;
  tone?: "accent" | "blue" | "dark";
};

export function IconBadge({ icon, tone = "accent" }: IconBadgeProps) {
  return (
    <span className={`icon-badge icon-badge-${tone}`} aria-hidden="true">
      <img alt="" src="/app-icon.png" data-icon={icon} />
    </span>
  );
}
