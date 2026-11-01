import { FileText, Folder, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FolderAccessReply, FolderAccessRow } from "./global";

export function FolderAccessSection() {
  const folderAccess = window.pdfReader?.folderAccess;
  const [folders, setFolders] = useState<FolderAccessRow[] | undefined>();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [recoverCommand, setRecoverCommand] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [damaged, setDamaged] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);

  const accept = useCallback((reply: FolderAccessReply) => {
    setMessage(reply.ok ? "" : reply.message);
    setRecoverCommand(reply.ok ? "" : reply.recoverCommand ?? "");
    setDamaged(!reply.ok && reply.reason === "damaged");
    if (reply.ok || reply.folders !== undefined) setFolders(reply.folders);
    if (!reply.ok && reply.reason === "damaged") setFolders(undefined);
    if (reply.ok && reply.stillReachable !== undefined) {
      const reachable = reply.stillReachable;
      setNotice(reachable.unknown
        ? "MarkPDF cannot check whether agents can still reach it."
        : [
            reachable.read ? `Agents can still read it through ${reachable.read}.` : "",
            reachable.write ? `Agents can still save files in it through ${reachable.write}.` : "",
          ].filter(Boolean).join(" "));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (pending.current || folderAccess === undefined) return;
    const request = ++revision.current;
    setLoading(true);
    try {
      const reply = await folderAccess.list();
      if (request === revision.current) accept(reply);
    } catch (error) {
      if (request === revision.current) {
        setMessage(error instanceof Error ? error.message : "Cannot load folder access.");
      }
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [accept, folderAccess]);

  useEffect(() => {
    void refresh(); // The loader handles failures and reports them in the section.
    const onFocus = () => {
      void refresh(); // Same handled loader for CLI edits.
    };
    window.addEventListener("focus", onFocus);
    return () => {
      revision.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const act = async (action: () => Promise<FolderAccessReply>) => {
    if (pending.current || folderAccess === undefined) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    const request = ++revision.current;
    try {
      const reply = await action();
      if (request !== revision.current) return;
      accept(reply);
      if (!reply.ok && reply.reason !== "damaged") {
        const fresh = await folderAccess.list();
        if (request === revision.current && fresh.ok) setFolders(fresh.folders);
      }
    } catch (error) {
      if (request === revision.current) {
        setMessage(error instanceof Error ? error.message : "Cannot change folder access.");
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const run = (action: () => Promise<FolderAccessReply>) => {
    void act(action); // act handles failures.
  };

  if (folderAccess === undefined) return null;
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <h3>Folder access</h3>
          <p>Folders that agents can open through the markpdf command and MCP, in this MarkPDF data directory.</p>
        </div>
        {!damaged && message && (
          <button
            className="secondary-button"
            disabled={busy || loading}
            onClick={() => { void refresh(); }}
          >
            Retry
          </button>
        )}
        {!damaged && (
          <button
            className="secondary-button"
            disabled={busy || folders === undefined}
            onClick={() => run(() => folderAccess.add())}
          >
            <Plus size={15} />Add folder
          </button>
        )}
      </div>
      {message && <p role="alert" className="settings-note">{message}</p>}
      {recoverCommand && <p className="settings-note"><code>{recoverCommand}</code></p>}
      {notice && <p role="status" className="settings-note">{notice}</p>}
      {!damaged && (folders !== undefined || loading) && (
        <div className="agent-list">
          {folders === undefined ? (
            <div className="empty-row">Loading folder access...</div>
          ) : folders.length === 0 ? (
            <div className="empty-row">
              No folders are granted for direct file access in this MarkPDF data directory.
              Agents can still search and read documents that are already indexed.
            </div>
          ) : folders.map(row => {
            const readDisabled = busy || (row.status !== "present" && row.level === "write");
            const writeDisabled = busy || row.status !== "present";
            return (
              <div className="agent-row" key={row.path}>
                <div className="agent-main">
                  {row.kind === "file" ? <FileText size={16} aria-label="File" /> : <Folder size={16} />}
                  <div>
                    <strong>{row.path}</strong>
                    {row.level === "write" && <span>Write only, set by the command line</span>}
                    {row.status === "missing" && <span>Not found</span>}
                    {row.status === "moved" && <span>Moved or replaced. Remove it and add it again.</span>}
                    {row.status === "unreadable" && <span>Cannot check this folder</span>}
                    {row.readThrough && <span>Also readable through {row.readThrough}</span>}
                    {row.writeThrough && <span>Also writable through {row.writeThrough}</span>}
                  </div>
                </div>
                <div className="folder-access-buttons" role="group" aria-label={`Access for ${row.path}`}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="secondary-button"
                        aria-label="Read"
                        aria-pressed={row.level === "read"}
                        aria-disabled={readDisabled}
                        onClick={() => {
                          if (!readDisabled) run(() => folderAccess.setLevel(row.path, "read"));
                        }}
                      >
                        R
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Read. Agents can find and read files here.</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="secondary-button"
                        aria-label="Read and write"
                        aria-pressed={row.level === "read-write"}
                        aria-disabled={writeDisabled}
                        onClick={() => {
                          if (!writeDisabled) run(() => folderAccess.setLevel(row.path, "read-write"));
                        }}
                      >
                        RW
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Read and write. Agents can also save files here.</TooltipContent>
                  </Tooltip>
                </div>
                <button
                  className="secondary-button"
                  aria-label={`Remove ${row.path}`}
                  disabled={busy}
                  onClick={() => run(() => folderAccess.remove(row.path))}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
