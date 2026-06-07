"use client";

import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, AlertCircle, CheckCircle2 } from "lucide-react";
import { SectionLabel } from "./SectionLabel";

const EXCITED_OPTIONS = [
  "AI Buy / Hold / Sell Verdicts",
  "Self-learning Accuracy Loop",
  "Live Broker Sync",
  "Daily News + Sentiment",
  "Portfolio Risk Dashboard",
  "Telegram Daily Push",
];

const BROKER_OPTIONS = [
  "Zerodha",
  "AngelOne",
  "Groww",
  "INDmoney",
  "Upstox",
  "Other",
];

type FormState = {
  name: string;
  email: string;
  phone: string;
  age: string;
  excited: string[];
  wanted: string;
  brokers: string[];
  brokerOther: string;
};

type Errors = Partial<Record<keyof FormState, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

function validate(form: FormState): Errors {
  const e: Errors = {};

  if (!form.name.trim()) e.name = "Name is required.";
  else if (form.name.trim().length < 2) e.name = "Name looks too short.";

  if (!form.email.trim()) e.email = "Email is required.";
  else if (!EMAIL_RE.test(form.email.trim())) e.email = "Enter a valid email.";

  const phoneDigits = digitsOnly(form.phone);
  if (!phoneDigits) {
    e.phone = "Phone is required.";
  } else if (phoneDigits.length !== 10) {
    e.phone = "Phone must be exactly 10 digits.";
  } else if (!/^[6-9]/.test(phoneDigits)) {
    e.phone = "Enter a valid Indian mobile (starts with 6-9).";
  }

  const ageNum = Number(form.age);
  if (!form.age.trim()) e.age = "Age is required.";
  else if (!Number.isInteger(ageNum)) e.age = "Age must be a whole number.";
  else if (ageNum < 13 || ageNum > 100) e.age = "Age must be between 13 and 100.";

  if (form.brokers.length === 0) e.brokers = "Pick at least one broker.";
  if (form.brokers.includes("Other") && !form.brokerOther.trim()) {
    e.brokerOther = "Please mention your broker.";
  }

  return e;
}

export function Waitlist() {
  const [form, setForm] = useState<FormState>({
    name: "",
    email: "",
    phone: "",
    age: "",
    excited: [],
    wanted: "",
    brokers: [],
    brokerOther: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [warningText, setWarningText] = useState<string>("");
  const warningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shakeControls = useAnimationControls();

  const liveErrors = useMemo(() => validate(form), [form]);

  useEffect(() => () => {
    if (warningTimer.current) clearTimeout(warningTimer.current);
  }, []);

  const flashWarning = (msg: string) => {
    setWarningText(msg);
    setWarning(msg);
    if (warningTimer.current) clearTimeout(warningTimer.current);
    warningTimer.current = setTimeout(() => setWarning(null), 4000);
  };

  const triggerShake = () => {
    shakeControls.start({
      x: [0, -10, 10, -8, 8, -5, 5, 0],
      transition: { duration: 0.5, ease: "easeInOut" },
    });
  };

  const setField = <K extends keyof FormState>(key: K, val: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
  };

  const toggleInList = (key: "excited" | "brokers", val: string) => {
    setForm((f) => {
      const list = f[key];
      const next = list.includes(val) ? list.filter((v) => v !== val) : [...list, val];
      return { ...f, [key]: next };
    });
  };

  const onPhoneChange = (raw: string) => {
    const cleaned = digitsOnly(raw).slice(0, 10);
    setField("phone", cleaned);
  };

  const onAgeChange = (raw: string) => {
    const cleaned = digitsOnly(raw).slice(0, 3);
    setField("age", cleaned);
  };

  const onBlur = (key: keyof FormState) => () => {
    setTouched((t) => ({ ...t, [key]: true }));
  };

  const showErr = (key: keyof FormState): string | undefined =>
    touched[key] || errors[key] ? liveErrors[key] : undefined;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const eMap = validate(form);
    setErrors(eMap);
    setTouched({
      name: true, email: true, phone: true, age: true,
      brokers: true, brokerOther: true,
    });
    if (Object.keys(eMap).length > 0) {
      triggerShake();
      flashWarning("Please fill in all required fields before joining.");
      return;
    }
    setWarning(null);

    setSubmitting(true);
    setServerError(null);
    try {
      const phoneOut = `+91${digitsOnly(form.phone)}`;

      const brokersOut = form.brokers
        .map((b) => (b === "Other" ? `Other: ${form.brokerOther.trim()}` : b))
        .join(", ");

      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          phone: phoneOut,
          age: Number(form.age),
          excited: form.excited.join(", "),
          wanted: form.wanted.trim(),
          broker: brokersOut,
          submittedAt: new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Submission failed (${res.status}).`);
      }
      setSubmitted(true);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section id="waitlist" className="py-28 px-6 relative border-t border-border">
      <div className="max-w-3xl mx-auto">
        <SectionLabel num="008" title="Waitlist" />
        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-5xl md:text-6xl font-semibold tracking-tight mb-6"
        >
          Join the <span className="italic">Early Access</span> list.
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.05 }}
          className="sub-headline mb-10 max-w-2xl"
        >
          Arc&apos;emX! is rolling out to a small first batch. Drop your details and we will reach out when your slot opens.
        </motion.p>

        {submitted ? (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="card p-10 text-center"
          >
            <CheckCircle2 className="size-10 mx-auto mb-4 text-[var(--gain)]" strokeWidth={1.6} />
            <h3 className="text-2xl font-semibold mb-2">You are on the list.</h3>
            <p className="text-sm text-[var(--muted)] max-w-md mx-auto">
              We will email you the moment your access is ready. Until then, keep watching the tape.
            </p>
          </motion.div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="card p-7 md:p-10 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Name" required error={showErr("name")}>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  onBlur={onBlur("name")}
                  placeholder="Your full name"
                  autoComplete="name"
                  className="form-input"
                />
              </Field>

              <Field label="Email" required error={showErr("email")}>
                <input
                  type="email"
                  inputMode="email"
                  value={form.email}
                  onChange={(e) => setField("email", e.target.value)}
                  onBlur={onBlur("email")}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="form-input"
                />
              </Field>

              <Field label="Phone" required hint="10-digit Indian mobile" error={showErr("phone")}>
                <div className="flex">
                  <span className="inline-flex items-center px-3 rounded-l-[14px] border border-r-0 border-border bg-[var(--muted-bg)] text-sm text-[var(--muted)] select-none">
                    +91
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={10}
                    value={form.phone}
                    onChange={(e) => onPhoneChange(e.target.value)}
                    onBlur={onBlur("phone")}
                    placeholder="9876543210"
                    autoComplete="tel-national"
                    className="form-input !rounded-l-none"
                  />
                </div>
              </Field>

              <Field label="Age" required error={showErr("age")}>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={3}
                  value={form.age}
                  onChange={(e) => onAgeChange(e.target.value)}
                  onBlur={onBlur("age")}
                  placeholder="e.g. 27"
                  className="form-input"
                />
              </Field>
            </div>

            <Field
              label="Which features are you most excited to try?"
              optional
              hint="Pick all that apply"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {EXCITED_OPTIONS.map((opt) => (
                  <ChipCheckbox
                    key={opt}
                    value={opt}
                    selected={form.excited.includes(opt)}
                    onToggle={() => toggleInList("excited", opt)}
                  />
                ))}
              </div>
            </Field>

            <Field
              label="Which brokers do you use?"
              required
              hint="Pick all that apply"
              error={showErr("brokers")}
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {BROKER_OPTIONS.map((opt) => (
                  <ChipCheckbox
                    key={opt}
                    value={opt}
                    selected={form.brokers.includes(opt)}
                    onToggle={() => toggleInList("brokers", opt)}
                  />
                ))}
              </div>
              <AnimatePresence initial={false}>
                {form.brokers.includes("Other") && (
                  <motion.div
                    key="broker-other"
                    initial={{ opacity: 0, height: 0, marginTop: 0 }}
                    animate={{ opacity: 1, height: "auto", marginTop: 12 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                    transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden"
                  >
                    <input
                      type="text"
                      value={form.brokerOther}
                      onChange={(e) => setField("brokerOther", e.target.value)}
                      onBlur={onBlur("brokerOther")}
                      placeholder="Please mention your broker(s)"
                      className="form-input"
                    />
                    {showErr("brokerOther") && (
                      <p className="mt-1.5 text-xs text-[var(--loss)]">{showErr("brokerOther")}</p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </Field>

            <Field label="Which feature would you like us to build next?" optional>
              <textarea
                value={form.wanted}
                onChange={(e) => setField("wanted", e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Tell us what would make this product a no-brainer for you."
                className="form-input resize-none"
              />
            </Field>

            {serverError && (
              <div className="text-sm text-[var(--loss)] border border-[color-mix(in_srgb,var(--loss)_35%,transparent)] bg-[color-mix(in_srgb,var(--loss)_8%,transparent)] rounded-2xl px-4 py-3">
                {serverError}
              </div>
            )}

            <div className="pt-2 space-y-3">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <p className="text-xs text-[var(--muted)]">
                  By joining, you agree to receive product updates. No spam. No tipsters.
                </p>
                <motion.button
                  type="submit"
                  disabled={submitting}
                  animate={shakeControls}
                  className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting ? "Joining..." : "Join Waitlist"}
                  {!submitting && <ArrowRight className="size-4" />}
                </motion.button>
              </div>
              <div
                className="grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{
                  gridTemplateRows: warning ? "1fr" : "0fr",
                  opacity: warning ? 1 : 0,
                }}
                aria-hidden={!warning}
              >
                <div className="overflow-hidden">
                  <div className="flex items-center justify-end gap-2 text-sm text-[var(--loss)] pt-1">
                    <AlertCircle className="size-4 shrink-0" strokeWidth={2} />
                    <span>{warningText || " "}</span>
                  </div>
                </div>
              </div>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

function Field({
  label,
  required,
  optional,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <span className="text-sm font-medium text-foreground">
          {label}
          {required && <span className="text-[var(--loss)] ml-1">*</span>}
          {optional && <span className="ml-2 text-[0.7rem] uppercase tracking-wider text-[var(--muted)]">Optional</span>}
        </span>
        {hint && <span className="text-[0.7rem] text-[var(--muted)] whitespace-nowrap">{hint}</span>}
      </div>
      {children}
      {error && <p className="mt-1.5 text-xs text-[var(--loss)]">{error}</p>}
    </label>
  );
}

function ChipCheckbox({
  value,
  selected,
  onToggle,
}: {
  value: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onToggle}
      whileTap={{ scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.6 }}
      className={
        "text-left text-sm px-4 py-2.5 rounded-2xl border " +
        "transition-[background-color,color,border-color] duration-200 ease-out " +
        (selected
          ? "bg-foreground text-background border-foreground"
          : "bg-[var(--muted-bg)] text-foreground border-border hover:border-foreground/40")
      }
    >
      {value}
    </motion.button>
  );
}
