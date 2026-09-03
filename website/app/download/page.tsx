"use client";

import { useEffect, useState } from "react";
import Nav from "../components/Nav";
import Footer from "../components/Footer";

type OS = "windows" | "mac" | "linux" | "unknown";

function detectOS(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "mac";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

const RELEASES = {
  windows: {
    label: "Windows",
    file: "PrintPort-Setup-1.1.0.exe",
    note: "Windows 10/11, 64-bit",
    available: true,
  },
  mac: {
    label: "macOS",
    file: null,
    note: "Not built yet — on the roadmap, see the docs page",
    available: false,
  },
  linux: {
    label: "Linux",
    file: null,
    note: "Not built yet — on the roadmap, see the docs page",
    available: false,
  },
} as const;

export default function DownloadPage() {
  const [os, setOs] = useState<OS>("unknown");

  useEffect(() => {
    setOs(detectOS());
  }, []);

  const detected = os !== "unknown" ? RELEASES[os] : null;

  return (
    <>
      <Nav />
      <main className="container">
        <section style={{ borderTop: "none", paddingTop: 56 }}>
          <h2>Download PrintPort</h2>
          <p className="lead">
            {detected
              ? `We detected ${detected.label}. Grab the right build below, or pick another OS.`
              : "Pick your operating system below."}
          </p>

          {(Object.keys(RELEASES) as (keyof typeof RELEASES)[]).map((key) => {
            const release = RELEASES[key];
            return (
              <div key={key} className={`card download-card ${os === key ? "detected" : ""}`} style={{ marginBottom: 16 }}>
                <div>
                  <h3>
                    {release.label} {os === key && <span className="badge">Recommended</span>}
                  </h3>
                  <p>{release.note}</p>
                </div>
                {release.available ? (
                  // Replace with a real hosted binary URL before shipping.
                  <a className="btn" href={`/releases/${release.file}`}>
                    Download for {release.label}
                  </a>
                ) : (
                  <button className="btn" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
                    Not available yet
                  </button>
                )}
              </div>
            );
          })}
        </section>

        <section>
          <h2>After installing</h2>
          <p className="lead">The installer registers auto-start and trusts PrintPort's local certificate for you.</p>
          <ul>
            <li>Windows: the app launches once automatically to generate and trust its local certificate — no manual step needed on most setups.</li>
            <li>Look for the PrintPort icon in your system tray — that confirms it's running.</li>
            <li>If a website ever shows a one-time certificate prompt, it now opens as a small popup that closes itself and reconnects automatically once you click through it.</li>
            <li>macOS and Linux builds are on the roadmap — see the <a href="/docs">docs page</a> for status.</li>
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}
