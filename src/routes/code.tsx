// Lazy route module for /code — loaded on first navigation to /code.
import { useShell } from "@/routes/shell-context";
import { CodeView } from "@/features/code/views-code";

export default function CodeRouteComponent() {
  const {
    openFiles,
    setOpenFiles,
    activeFile,
    setActiveFile,
    fileContents,
    setFileContents,
    editorViewRef,
  } = useShell();
  return (
    <CodeView
      activeFile={activeFile}
      openFiles={openFiles}
      setOpenFiles={setOpenFiles}
      setActiveFile={setActiveFile}
      fileContents={fileContents}
      setFileContents={setFileContents}
      editorViewRef={editorViewRef}
    />
  );
}
