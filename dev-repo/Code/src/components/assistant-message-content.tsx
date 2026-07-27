import type { ReactNode } from "react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const INLINE_TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g
const TABLE_DIVIDER_CELL = /^:?-{3,}:?$/

type TableAlignment = "left" | "center" | "right"

const renderInline = (text: string): ReactNode[] =>
  text.split(INLINE_TOKEN).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${index}-${part}`} className="font-semibold text-inherit">{part.slice(2, -2)}</strong>
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${index}-${part}`} className="rounded bg-black/20 px-1 py-0.5 text-[.9em]">{part.slice(1, -1)}</code>
    }
    return part
  })

const splitMarkdownTableRow = (value: string) => {
  let row = value.trim()
  if (row.startsWith("|")) row = row.slice(1)
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1)

  const cells: string[] = []
  let cell = ""
  let inCode = false
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]
    if (character === "\\" && row[index + 1] === "|") {
      cell += "|"
      index += 1
      continue
    }
    if (character === "`") inCode = !inCode
    if (character === "|" && !inCode) {
      cells.push(cell.trim())
      cell = ""
      continue
    }
    cell += character
  }
  cells.push(cell.trim())
  return cells
}

const isTableStart = (lines: string[], index: number) => {
  const headerLine = lines[index]?.trim() || ""
  const dividerLine = lines[index + 1]?.trim() || ""
  if (!headerLine.includes("|") || !dividerLine.includes("|")) return false
  const headers = splitMarkdownTableRow(headerLine)
  const dividers = splitMarkdownTableRow(dividerLine)
  return headers.length > 0
    && headers.length === dividers.length
    && dividers.every((cell) => TABLE_DIVIDER_CELL.test(cell))
}

const tableAlignment = (divider: string): TableAlignment => {
  if (divider.startsWith(":") && divider.endsWith(":")) return "center"
  if (divider.endsWith(":")) return "right"
  return "left"
}

const alignmentClassName = (alignment: TableAlignment) => {
  if (alignment === "center") return "text-center"
  if (alignment === "right") return "text-right"
  return "text-left"
}

export function AssistantMessageContent({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n")
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line) {
      index += 1
      continue
    }

    if (isTableStart(lines, index)) {
      const tableIndex = index
      const headers = splitMarkdownTableRow(lines[index])
      const dividers = splitMarkdownTableRow(lines[index + 1])
      const alignments = dividers.map(tableAlignment)
      const rows: string[][] = []
      index += 2
      while (index < lines.length) {
        const row = lines[index].trim()
        if (!row || !row.includes("|")) break
        const cells = splitMarkdownTableRow(row)
        rows.push(Array.from({ length: headers.length }, (_, cellIndex) => cells[cellIndex] || ""))
        index += 1
      }
      blocks.push(
        <Table key={`table-${tableIndex}`} className="max-w-full min-w-max text-xs" aria-label="智能助手回答表格">
            <TableHeader>
              <TableRow>
                {headers.map((header, cellIndex) => (
                  <TableHead
                    key={`${cellIndex}-${header}`}
                    className={`h-9 min-w-24 whitespace-nowrap py-2 ${alignmentClassName(alignments[cellIndex])}`}
                  >
                    {renderInline(header)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={`row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <TableCell
                      key={`${cellIndex}-${cell}`}
                      className={`h-auto min-w-24 whitespace-normal py-2 align-top ${alignmentClassName(alignments[cellIndex])}`}
                    >
                      {renderInline(cell)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
        </Table>,
      )
      continue
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push(<h3 key={`heading-${index}`} className="pt-1 text-sm font-semibold text-foreground">{renderInline(heading[2])}</h3>)
      index += 1
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*]\s+(.+)$/)
        if (!match) break
        items.push(match[1])
        index += 1
      }
      blocks.push(
        <ul key={`list-${index}`} className="list-disc space-y-1 pl-5">
          {items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>)}
        </ul>,
      )
      continue
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/)
        if (!match) break
        items.push(match[1])
        index += 1
      }
      blocks.push(
        <ol key={`steps-${index}`} className="list-decimal space-y-1 pl-5">
          {items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>)}
        </ol>,
      )
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length) {
      const next = lines[index].trim()
      if (!next || isTableStart(lines, index) || /^(?:#{1,3}\s+|[-*]\s+|\d+[.)]\s+)/.test(next)) break
      paragraph.push(next)
      index += 1
    }
    blocks.push(<p key={`paragraph-${index}`} className="w-full whitespace-pre-wrap break-all [overflow-wrap:anywhere]">{renderInline(paragraph.join("\n"))}</p>)
  }

  return <div className="w-full min-w-0 max-w-full space-y-2 break-words [overflow-wrap:anywhere]">{blocks}</div>
}
