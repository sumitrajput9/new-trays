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
    file: "PrintTrays-Setup-1.2.0.exe",
    note: "Windows 10/11, 64-bit",
    available: true,
    altFile: null as string | null,
    altLabel: null as string | null,
  },
  mac: {
    label: "macOS",
    file: null as string | null,
    note: "Not built yet — on the roadmap, see the docs page",
    available: false,
    altFile: null as string | null,
    altLabel: null as string | null,
  },
  linux: {
    label: "Linux",
    file: "PrintTrays-1.2.0.AppImage" as string | null,
    note: "AppImage, x64 — also available as .deb",
    available: true,
    altFile: "printtrays-server_1.2.0_amd64.deb" as string | null,
    altLabel: ".deb (Debian/Ubuntu)" as string | null,
  },
};

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
          <h2>Download PrintTrays</h2>
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
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {/* Replace with a real hosted binary URL before shipping. */}
                    <a className="btn" href={`/releases/${release.file}`}>
                      Download for {release.label}
                    </a>
                    {release.altFile && (
                      <a className="btn-ghost" href={`/releases/${release.altFile}`}>
                        {release.altLabel}
                      </a>
                    )}
                  </div>
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
          <p className="lead">The installer registers auto-start and trusts PrintTrays's local certificate for you.</p>
          <ul>
            <li>Windows: the app launches once automatically to generate and trust its local certificate — no manual step needed on most setups.</li>
            <li>
              Linux: the <code>.deb</code> package's post-install script does this for you automatically. The
              <code>.AppImage</code> has no install step to hook into — run{" "}
              <code>./PrintTrays-1.2.0.AppImage --generate-cert-and-exit</code> once, then follow{" "}
              <code>installers/linux/postinst.sh</code> manually (or just use the <code>.deb</code> instead).
            </li>
            <li>Look for the PrintTrays icon in your system tray — that confirms it's running.</li>
            <li>If a website ever shows a one-time certificate prompt, it now opens as a small popup that closes itself and reconnects automatically once you click through it.</li>
            <li>macOS is still on the roadmap — see the <a href="/docs">docs page</a> for status.</li>
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}
