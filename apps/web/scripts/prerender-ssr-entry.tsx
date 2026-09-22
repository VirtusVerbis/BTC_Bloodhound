import { renderToString } from "react-dom/server";
import { AboutPage } from "../src/components/AboutPage";

export function renderAboutHtml(): string {
  return renderToString(<AboutPage sync={null} />);
}
