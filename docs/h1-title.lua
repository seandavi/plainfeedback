-- The docs are plain GitHub markdown with a leading "# Title" and no front matter
-- (apps/web imports grammar.md raw), so make that heading the page title and <title>.
function Pandoc(doc)
  local first = doc.blocks[1]
  if doc.meta.title == nil and first and first.t == "Header" and first.level == 1 then
    doc.meta.title = first.content
    doc.meta.pagetitle = pandoc.utils.stringify(first.content)
    doc.blocks:remove(1)
  end
  return doc
end
