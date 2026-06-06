import {
  Group,
  Panel,
  Separator
} from "react-resizable-panels";

export const ResizablePanelGroup = Group;
export const ResizablePanel = Panel;

export function ResizableHandle() {
  return <Separator className="resizable-handle" />;
}
