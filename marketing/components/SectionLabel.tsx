interface Props {
  num: string;
  title: string;
}

export function SectionLabel({ num, title }: Props) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="section-num">{num}</span>
      <span className="h-px w-12 bg-border" />
      <span className="section-num !text-foreground">{title}</span>
    </div>
  );
}
