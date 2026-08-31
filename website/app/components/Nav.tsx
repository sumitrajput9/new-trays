import Link from "next/link";

export default function Nav() {
  return (
    <div className="container">
      <nav className="nav">
        <Link href="/" className="brand">
          <span className="mark" />
          PrintPort
        </Link>
        <div className="nav-links">
          <Link href="/download">Download</Link>
          <Link href="/demo">Live Demo</Link>
          <Link href="/docs">Docs</Link>
          <a href="https://github.com" target="_blank" rel="noopener">
            GitHub
          </a>
        </div>
      </nav>
    </div>
  );
}
