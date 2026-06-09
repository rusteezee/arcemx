// Mirror of /data/universe.csv for client-side use by the Sensei
// Calculator (Phase 8a). The canonical list is the CSV (read by
// fetchers/prices.py at cron time). Keep these two in sync when
// expanding the universe.

export type Cap = "large" | "mid" | "small";

export interface UniverseRow {
  ticker: string;
  name: string;
  cap: Cap;
  sector: string;
}

// All NSE-listed tickers in the universe. Indices (^NSEI etc.) live
// in the CSV for the prices fetcher; they are excluded here because
// the calculator picks individual stocks only.
export const UNIVERSE: UniverseRow[] = [
  { ticker: "RELIANCE.NS",    name: "Reliance Industries",            cap: "large", sector: "ENERGY" },
  { ticker: "TCS.NS",         name: "Tata Consultancy Services",      cap: "large", sector: "IT" },
  { ticker: "HDFCBANK.NS",    name: "HDFC Bank",                       cap: "large", sector: "BANK" },
  { ticker: "INFY.NS",        name: "Infosys",                         cap: "large", sector: "IT" },
  { ticker: "ICICIBANK.NS",   name: "ICICI Bank",                      cap: "large", sector: "BANK" },
  { ticker: "HINDUNILVR.NS",  name: "Hindustan Unilever",              cap: "large", sector: "FMCG" },
  { ticker: "ITC.NS",         name: "ITC",                             cap: "large", sector: "FMCG" },
  { ticker: "SBIN.NS",        name: "State Bank of India",             cap: "large", sector: "BANK" },
  { ticker: "BHARTIARTL.NS",  name: "Bharti Airtel",                   cap: "large", sector: "TELECOM" },
  { ticker: "KOTAKBANK.NS",   name: "Kotak Mahindra Bank",             cap: "large", sector: "BANK" },
  { ticker: "LT.NS",          name: "Larsen & Toubro",                 cap: "large", sector: "INFRA" },
  { ticker: "AXISBANK.NS",    name: "Axis Bank",                       cap: "large", sector: "BANK" },
  { ticker: "ASIANPAINT.NS",  name: "Asian Paints",                    cap: "large", sector: "CONSUMER" },
  { ticker: "MARUTI.NS",      name: "Maruti Suzuki",                   cap: "large", sector: "AUTO" },
  { ticker: "HCLTECH.NS",     name: "HCL Tech",                        cap: "large", sector: "IT" },
  { ticker: "SUNPHARMA.NS",   name: "Sun Pharma",                      cap: "large", sector: "PHARMA" },
  { ticker: "TITAN.NS",       name: "Titan",                           cap: "large", sector: "CONSUMER" },
  { ticker: "BAJFINANCE.NS",  name: "Bajaj Finance",                   cap: "large", sector: "FINSERV" },
  { ticker: "WIPRO.NS",       name: "Wipro",                           cap: "large", sector: "IT" },
  { ticker: "ULTRACEMCO.NS",  name: "UltraTech Cement",                cap: "large", sector: "INFRA" },
  { ticker: "NESTLEIND.NS",   name: "Nestle India",                    cap: "large", sector: "FMCG" },
  { ticker: "ADANIENT.NS",    name: "Adani Enterprises",               cap: "large", sector: "INFRA" },
  { ticker: "NTPC.NS",        name: "NTPC",                            cap: "large", sector: "ENERGY" },
  { ticker: "POWERGRID.NS",   name: "Power Grid",                      cap: "large", sector: "ENERGY" },
  { ticker: "M&M.NS",         name: "Mahindra & Mahindra",             cap: "large", sector: "AUTO" },
  { ticker: "TATASTEEL.NS",   name: "Tata Steel",                      cap: "large", sector: "METAL" },
  { ticker: "JSWSTEEL.NS",    name: "JSW Steel",                       cap: "large", sector: "METAL" },
  { ticker: "ONGC.NS",        name: "ONGC",                            cap: "large", sector: "ENERGY" },
  { ticker: "COALINDIA.NS",   name: "Coal India",                      cap: "large", sector: "ENERGY" },
  { ticker: "HINDALCO.NS",    name: "Hindalco",                        cap: "large", sector: "METAL" },
  { ticker: "ADANIPORTS.NS",  name: "Adani Ports",                     cap: "large", sector: "INFRA" },
  { ticker: "GRASIM.NS",      name: "Grasim",                          cap: "large", sector: "INFRA" },
  { ticker: "BAJAJFINSV.NS",  name: "Bajaj Finserv",                   cap: "large", sector: "FINSERV" },
  { ticker: "BPCL.NS",        name: "BPCL",                            cap: "large", sector: "ENERGY" },
  { ticker: "BRITANNIA.NS",   name: "Britannia",                       cap: "large", sector: "FMCG" },
  { ticker: "CIPLA.NS",       name: "Cipla",                           cap: "large", sector: "PHARMA" },
  { ticker: "DIVISLAB.NS",    name: "Divis Lab",                       cap: "large", sector: "PHARMA" },
  { ticker: "DRREDDY.NS",     name: "Dr Reddy's",                      cap: "large", sector: "PHARMA" },
  { ticker: "EICHERMOT.NS",   name: "Eicher Motors",                   cap: "large", sector: "AUTO" },
  { ticker: "HEROMOTOCO.NS",  name: "Hero MotoCorp",                   cap: "large", sector: "AUTO" },
  { ticker: "INDUSINDBK.NS",  name: "IndusInd Bank",                   cap: "large", sector: "BANK" },
  { ticker: "SBILIFE.NS",     name: "SBI Life",                        cap: "large", sector: "FINSERV" },
  { ticker: "SHRIRAMFIN.NS",  name: "Shriram Finance",                 cap: "large", sector: "FINSERV" },
  { ticker: "TATACONSUM.NS",  name: "Tata Consumer",                   cap: "large", sector: "FMCG" },
  { ticker: "TECHM.NS",       name: "Tech Mahindra",                   cap: "large", sector: "IT" },
  { ticker: "TRENT.NS",       name: "Trent",                           cap: "large", sector: "CONSUMER" },
  { ticker: "APOLLOHOSP.NS",  name: "Apollo Hospitals",                cap: "large", sector: "PHARMA" },
  { ticker: "BAJAJ-AUTO.NS",  name: "Bajaj Auto",                      cap: "large", sector: "AUTO" },
  { ticker: "HDFCLIFE.NS",    name: "HDFC Life",                       cap: "large", sector: "FINSERV" },
  { ticker: "TATAPOWER.NS",   name: "Tata Power",                      cap: "mid",   sector: "ENERGY" },
  { ticker: "ANGELONE.NS",    name: "Angel One",                       cap: "mid",   sector: "FINSERV" },
  { ticker: "ETERNAL.NS",     name: "Eternal",                         cap: "mid",   sector: "CONSUMER" },
  { ticker: "VEDL.NS",        name: "Vedanta",                         cap: "mid",   sector: "METAL" },
  { ticker: "ADANIGREEN.NS",  name: "Adani Green Energy",              cap: "mid",   sector: "ENERGY" },
  { ticker: "GROWW.NS",       name: "Groww",                           cap: "mid",   sector: "FINSERV" },
  { ticker: "ADANIPOWER.NS",  name: "Adani Power",                     cap: "mid",   sector: "ENERGY" },
  { ticker: "AMBUJACEM.NS",   name: "Ambuja Cements",                  cap: "mid",   sector: "INFRA" },
  { ticker: "IRCTC.NS",       name: "IRCTC",                           cap: "mid",   sector: "CONSUMER" },
  { ticker: "POLYCAB.NS",     name: "Polycab India",                   cap: "mid",   sector: "CONSUMER" },
  { ticker: "COFORGE.NS",     name: "Coforge",                         cap: "mid",   sector: "IT" },
  { ticker: "HAVELLS.NS",     name: "Havells India",                   cap: "mid",   sector: "CONSUMER" },
  { ticker: "MPHASIS.NS",     name: "Mphasis",                         cap: "mid",   sector: "IT" },
  { ticker: "PERSISTENT.NS",  name: "Persistent Systems",              cap: "mid",   sector: "IT" },
  { ticker: "LUPIN.NS",       name: "Lupin",                           cap: "mid",   sector: "PHARMA" },
  { ticker: "BANKBARODA.NS",  name: "Bank of Baroda",                  cap: "mid",   sector: "BANK" },
  { ticker: "GODREJCP.NS",    name: "Godrej Consumer",                 cap: "mid",   sector: "FMCG" },
  { ticker: "DABUR.NS",       name: "Dabur India",                     cap: "mid",   sector: "FMCG" },
  { ticker: "TVSMOTOR.NS",    name: "TVS Motor",                       cap: "mid",   sector: "AUTO" },
  { ticker: "SUZLON.NS",      name: "Suzlon Energy",                   cap: "small", sector: "ENERGY" },
  { ticker: "WAAREERTL.NS",   name: "Waaree Renewable Technologies",   cap: "small", sector: "ENERGY" },
  { ticker: "ATHERENERG.NS",  name: "Ather Energy",                    cap: "small", sector: "AUTO" },
  { ticker: "KIRLOSKARI.NS",  name: "Kirloskar Industries",            cap: "small", sector: "INFRA" },
  { ticker: "FINOLEXIND.NS",  name: "Finolex Industries",              cap: "small", sector: "INFRA" },
  { ticker: "KPRMILL.NS",     name: "KPR Mill",                        cap: "small", sector: "CONSUMER" },
  { ticker: "SUNDARMFIN.NS",  name: "Sundaram Finance",                cap: "small", sector: "FINSERV" },
  { ticker: "VSTIND.NS",      name: "VST Industries",                  cap: "small", sector: "FMCG" },
  { ticker: "NATCOPHARM.NS",  name: "Natco Pharma",                    cap: "small", sector: "PHARMA" },
  { ticker: "JBCHEPHARM.NS",  name: "J B Chemicals & Pharma",          cap: "small", sector: "PHARMA" },
  { ticker: "CROMPTON.NS",    name: "Crompton Greaves Consumer",       cap: "small", sector: "CONSUMER" },
  { ticker: "DEEPAKNTR.NS",   name: "Deepak Nitrite",                  cap: "small", sector: "CHEMICALS" },
  { ticker: "SRF.NS",         name: "SRF",                             cap: "small", sector: "CHEMICALS" },
  { ticker: "ASTRAL.NS",      name: "Astral",                          cap: "small", sector: "INFRA" },
  { ticker: "SUPREMEIND.NS",  name: "Supreme Industries",              cap: "small", sector: "INFRA" },
  { ticker: "APARINDS.NS",    name: "Apar Industries",                 cap: "small", sector: "ENERGY" },
  { ticker: "NHPC.NS",        name: "NHPC",                            cap: "small", sector: "ENERGY" },
];

export const SECTORS = Array.from(new Set(UNIVERSE.map((u) => u.sector))).sort();
export const CAPS: Cap[] = ["large", "mid", "small"];
