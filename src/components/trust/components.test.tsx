// Trust-UX primitives — render smoke tests (Lane 5).
//
// No @testing-library is available in this project, so we render to static markup
// (react-dom/server) and assert on the output. This catches the cheap-but-real
// failure modes: a component that throws on render, a badge that drops its text
// label (leaving color as the only signal — an accessibility regression), or a
// clickable element that's secretly a <div> instead of a <button>.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RiskBadge } from "./RiskBadge";
import { PermissionBadge } from "./PermissionBadge";
import { InlineNotice } from "./InlineNotice";
import { ModeBadge } from "./ModeBadge";
import { ConfirmDialog } from "./ConfirmDialog";

describe("RiskBadge", () => {
  it("always renders a text label, not just a color (a11y)", () => {
    const html = renderToStaticMarkup(<RiskBadge level="exec" />);
    expect(html).toContain("Exécution");
  });

  it("renders the read tier label", () => {
    const html = renderToStaticMarkup(<RiskBadge level="read" />);
    expect(html).toContain("Lecture");
  });

  it("appends the blurb when showBlurb is set", () => {
    const html = renderToStaticMarkup(<RiskBadge level="write" showBlurb />);
    expect(html).toContain("Écriture");
    expect(html).toContain("modifier des fichiers");
  });
});

describe("PermissionBadge", () => {
  it("renders a plain span when not clickable", () => {
    const html = renderToStaticMarkup(
      <PermissionBadge kind="private" label="Privé · sur ta machine" />,
    );
    expect(html).toContain("Privé · sur ta machine");
    expect(html).toMatch(/^<span/);
  });

  it("renders a real <button> when an onClick is supplied (no div onClick)", () => {
    const html = renderToStaticMarkup(
      <PermissionBadge kind="guarded" label="Filet git" onClick={() => {}} />,
    );
    expect(html).toMatch(/^<button/);
    expect(html).toContain('type="button"');
    expect(html).toContain("Filet git");
  });
});

describe("InlineNotice", () => {
  it("uses role=alert for warn/danger tones", () => {
    expect(renderToStaticMarkup(<InlineNotice tone="warn">x</InlineNotice>)).toContain(
      'role="alert"',
    );
    expect(renderToStaticMarkup(<InlineNotice tone="danger">x</InlineNotice>)).toContain(
      'role="alert"',
    );
  });

  it("uses role=status for info/success tones", () => {
    expect(renderToStaticMarkup(<InlineNotice tone="info">x</InlineNotice>)).toContain(
      'role="status"',
    );
  });

  it("renders the action as a real button", () => {
    const html = renderToStaticMarkup(
      <InlineNotice tone="warn" action={{ label: "Revérifier", onClick: () => {} }}>
        net down
      </InlineNotice>,
    );
    expect(html).toContain("Revérifier");
    expect(html).toContain("<button");
  });
});

describe("ModeBadge", () => {
  it("shows Act for agent mode", () => {
    expect(renderToStaticMarkup(<ModeBadge mode="agent" />)).toContain("Act");
  });
  it("shows Plan for plan mode", () => {
    expect(renderToStaticMarkup(<ModeBadge mode="plan" />)).toContain("Plan");
  });
  it("shows Ask for chat mode", () => {
    expect(renderToStaticMarkup(<ModeBadge mode="chat" />)).toContain("Ask");
  });
  it("falls back to Act on an unknown mode", () => {
    expect(renderToStaticMarkup(<ModeBadge mode="???" />)).toContain("Act");
  });
});

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Sure?"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});
