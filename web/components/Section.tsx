import { ReactNode } from "react";

interface SectionProps {
  num: string;
  title: string;
  glyph?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Section({ num, title, glyph = "✦", description, action, children }: SectionProps) {
  return (
    <section className="mb-14">
      <div className="flex items-end justify-between mb-5 gap-4 flex-wrap">
        <div>
          <div className="section-num mb-2">{num}</div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-3">
            <span className="glyph text-lg">{glyph}</span>
            {title}
          </h2>
          {description && (
            <p className="sub-headline mt-1.5 max-w-2xl">{description}</p>
          )}
        </div>
        {action && <div>{action}</div>}
      </div>
      {children}
    </section>
  );
}
