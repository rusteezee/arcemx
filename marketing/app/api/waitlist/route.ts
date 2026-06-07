import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

type Payload = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  age?: unknown;
  excited?: unknown;
  wanted?: unknown;
  broker?: unknown;
  submittedAt?: unknown;
};

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function validate(body: Payload) {
  const name = asStr(body.name);
  const email = asStr(body.email);
  const phone = asStr(body.phone);
  const age = typeof body.age === "number" ? body.age : Number(asStr(body.age));
  const excited = asStr(body.excited);
  const wanted = asStr(body.wanted);
  const broker = asStr(body.broker);

  if (!name || name.length < 2) return { ok: false as const, error: "Invalid name." };
  if (!email || !EMAIL_RE.test(email)) return { ok: false as const, error: "Invalid email." };

  const digits = phone.replace(/\D+/g, "");
  let core: string;
  if (digits.length === 12 && digits.startsWith("91")) {
    core = digits.slice(2);
  } else if (digits.length === 10) {
    core = digits;
  } else {
    return { ok: false as const, error: "Phone must be exactly 10 digits." };
  }
  if (!/^[6-9]\d{9}$/.test(core)) {
    return { ok: false as const, error: "Invalid Indian mobile number." };
  }
  const phoneOut = `+91${core}`;

  if (!Number.isInteger(age) || age < 13 || age > 100) {
    return { ok: false as const, error: "Invalid age." };
  }

  if (!broker) return { ok: false as const, error: "Broker is required." };

  return {
    ok: true as const,
    data: {
      name,
      email,
      phone: phoneOut,
      age,
      excited,
      wanted,
      broker,
      submittedAt: asStr(body.submittedAt) || new Date().toISOString(),
    },
  };
}

export async function POST(req: NextRequest) {
  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = validate(body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  const webhookUrl = process.env.WAITLIST_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("[waitlist] WAITLIST_WEBHOOK_URL is not configured.");
    return Response.json({ error: "Server not configured." }, { status: 500 });
  }

  try {
    const upstream = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.data),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      console.error(`[waitlist] Upstream ${upstream.status}: ${text.slice(0, 500)}`);
      return Response.json({ error: "Could not save your entry. Please try again." }, { status: 502 });
    }
  } catch (err) {
    console.error("[waitlist] Upstream fetch failed:", err);
    return Response.json({ error: "Network error. Please try again." }, { status: 502 });
  }

  return Response.json({ ok: true });
}
