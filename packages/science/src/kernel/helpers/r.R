MAX_OUTPUT_BYTES <- 64 * 1024
TRUNCATED <- "\n... (truncated)"

bounded <- function(value) {
  text <- enc2utf8(paste(value, collapse = "\n"))
  if (nchar(text, type = "bytes") <= MAX_OUTPUT_BYTES) return(text)

  limit <- MAX_OUTPUT_BYTES - nchar(TRUNCATED, type = "bytes")
  chars <- intToUtf8(utf8ToInt(text), multiple = TRUE)
  size <- 0L
  kept <- character()
  for (char in chars) {
    bytes <- nchar(char, type = "bytes")
    if (size + bytes > limit) break
    kept <- c(kept, char)
    size <- size + bytes
  }
  paste0(paste(kept, collapse = ""), TRUNCATED)
}

json_string <- function(value) {
  encodeString(bounded(value), quote = "\"")
}

execute <- function(code) {
  out <- character()
  err <- character()
  value <- ""
  status <- "ok"
  out_con <- textConnection("out", "w", local = TRUE)
  err_con <- textConnection("err", "w", local = TRUE)
  tryCatch({
    sink(out_con)
    sink(err_con, type = "message")
    expressions <- parse(text = code)
    visible <- FALSE
    result <- NULL
    for (expression in expressions) {
      evaluated <- withVisible(eval(expression, envir = .GlobalEnv))
      result <- evaluated$value
      visible <- evaluated$visible
    }
    if (visible) value <- paste(capture.output(print(result)), collapse = "\n")
  }, error = function(error) {
    status <<- "error"
    err <<- c(err, conditionMessage(error))
  }, finally = {
    sink(type = "message")
    sink()
    close(out_con)
    close(err_con)
  })
  paste0(
    "{\"status\":", json_string(status),
    ",\"stdout\":", json_string(out),
    ",\"stderr\":", json_string(err),
    ",\"value\":", json_string(value), "}"
  )
}

input <- file("stdin", "r")
repeat {
  header <- readLines(input, n = 1, warn = FALSE)
  if (length(header) == 0) break
  size <- suppressWarnings(as.integer(header))
  if (is.na(size) || size < 0 || size > 65536) {
    cat("{\"status\":\"error\",\"stdout\":\"\",\"stderr\":\"invalid cell size\",\"value\":\"\"}\n")
    flush.console()
    next
  }
  code <- suppressWarnings(readChar(input, nchars = size, useBytes = TRUE))
  if (nchar(code, type = "bytes") != size) break
  cat(execute(code), "\n", sep = "")
  flush.console()
}
