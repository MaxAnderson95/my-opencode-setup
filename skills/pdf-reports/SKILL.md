---
name: pdf-reports
description: Generate PDF reports by writing markdown and converting with the locally installed md2pdf CLI. Use when the user asks for a PDF report, asks for a report "as a PDF", or asks to export or convert a document to PDF.
---

# PDF Reports

When Max asks for a PDF report (specifically PDF):

1. Write the report to a local `.md` file in markdown format.
2. Convert it using the `md2pdf` CLI installed locally.
3. Leave the `.md` around for reading and further edits. After any edits, re-generate the PDF with `md2pdf`.
