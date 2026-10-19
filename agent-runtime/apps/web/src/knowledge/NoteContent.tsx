import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./knowledge.module.css";

/** Local note content never loads embedded resources or executes raw HTML. */
export function NoteContent({ content }: { content: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={[
          "p",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "ul",
          "ol",
          "li",
          "blockquote",
          "pre",
          "code",
          "em",
          "strong",
          "del",
          "hr",
          "br",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
        ]}
        unwrapDisallowed
      >
        {content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}
      </ReactMarkdown>
    </div>
  );
}
