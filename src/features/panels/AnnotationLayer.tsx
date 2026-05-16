// Shugu Forge — annotation overlay.
//
// Renders a flat list of Annotation bubbles (flags, tags, comments, pins)
// positioned absolutely over the host viewport. The host (RootLayout) owns
// the annotations array (created by ContextMenu's onAnnotate callback) and
// passes onRemove to clear an entry when the user clicks it.

export function AnnotationLayer({ annotations, onRemove }: any) {
  return (
    <>
      {annotations.map((a: any) => (
        <div key={a.id} className="anno-bubble" style={{ left: a.x, top: a.y }}>
          {a.kind === "flag" && (
            <div className="anno-flag" style={{ borderColor: `transparent ${a.payload?.hex || '#e08efe'} transparent transparent` }} title={a.payload?.name + " · " + (a.label || '')} onClick={() => onRemove(a.id)}/>
          )}
          {a.kind === "tag" && (
            <span className="chip" style={{background: (a.payload?.hex || '#e08efe') + '22', borderColor: a.payload?.hex, color: a.payload?.hex, textTransform:'uppercase', fontFamily:'var(--font-mono)', fontSize:9}}>
              {a.payload?.name}
            </span>
          )}
          {a.kind === "comment" && (
            <div className="anno-comment" onClick={() => onRemove(a.id)}>
              <div className="head">comment · {a.author || "you"}</div>
              {a.text}
            </div>
          )}
          {a.kind === "pin" && <div className="anno-pin" title={a.label}/>}
        </div>
      ))}
    </>
  );
}
