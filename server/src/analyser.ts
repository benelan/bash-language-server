import * as fs from 'fs'
import * as FuzzySearch from 'fuzzy-search'
import fetch from 'node-fetch'
import * as url from 'url'
import { isDeepStrictEqual } from 'util'
import * as LSP from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import * as Parser from 'web-tree-sitter'

import { flattenArray } from './util/array'
import {
  getAllDeclarationsInTree,
  getGlobalDeclarations,
  getLocalDeclarations,
  GlobalDeclarations,
} from './util/declarations'
import { getFilePaths } from './util/fs'
import { logger } from './util/logger'
import { isPositionIncludedInRange } from './util/lsp'
import { analyzeShebang } from './util/shebang'
import * as sourcing from './util/sourcing'
import * as TreeSitterUtil from './util/tree-sitter'

type AnalyzedDocument = {
  document: TextDocument
  globalDeclarations: GlobalDeclarations
  sourcedUris: Set<string>
  sourceCommands: sourcing.SourceCommand[]
  tree: Parser.Tree
}

/**
 * The Analyzer uses the Abstract Syntax Trees (ASTs) that are provided by
 * tree-sitter to find definitions, reference, etc.
 */
export default class Analyzer {
  private enableSourceErrorDiagnostics: boolean
  private includeAllWorkspaceSymbols: boolean
  private parser: Parser
  private uriToAnalyzedDocument: Record<string, AnalyzedDocument | undefined> = {}
  private workspaceFolder: string | null

  public constructor({
    enableSourceErrorDiagnostics = false,
    includeAllWorkspaceSymbols = false,
    parser,
    workspaceFolder,
  }: {
    enableSourceErrorDiagnostics?: boolean
    includeAllWorkspaceSymbols?: boolean
    parser: Parser
    workspaceFolder: string | null
  }) {
    this.enableSourceErrorDiagnostics = enableSourceErrorDiagnostics
    this.includeAllWorkspaceSymbols = includeAllWorkspaceSymbols
    this.parser = parser
    this.workspaceFolder = workspaceFolder
  }

  /**
   * Analyze the given document, cache the tree-sitter AST, and iterate over the
   * tree to find declarations.
   */
  public analyze({
    document,
    uri, // NOTE: we don't use document.uri to make testing easier
  }: {
    document: TextDocument
    uri: string
  }): LSP.Diagnostic[] {
    const diagnostics: LSP.Diagnostic[] = []
    const fileContent = document.getText()

    const tree = this.parser.parse(fileContent)

    const globalDeclarations = getGlobalDeclarations({ tree, uri })

    const sourceCommands = sourcing.getSourceCommands({
      fileUri: uri,
      rootPath: this.workspaceFolder,
      tree,
    })

    const sourcedUris = new Set(
      sourceCommands
        .map((sourceCommand) => sourceCommand.uri)
        .filter((uri): uri is string => uri !== null),
    )

    this.uriToAnalyzedDocument[uri] = {
      document,
      globalDeclarations,
      sourcedUris,
      sourceCommands: sourceCommands.filter((sourceCommand) => !sourceCommand.error),
      tree,
    }

    if (!this.includeAllWorkspaceSymbols) {
      sourceCommands
        .filter((sourceCommand) => sourceCommand.error)
        .forEach((sourceCommand) => {
          logger.warn(
            `${uri} line ${sourceCommand.range.start.line}: ${sourceCommand.error}`,
          )

          if (this.enableSourceErrorDiagnostics) {
            diagnostics.push(
              LSP.Diagnostic.create(
                sourceCommand.range,
                [
                  `Source command could not be analyzed: ${sourceCommand.error}.\n`,
                  'Consider adding a ShellCheck directive above this line to fix or ignore this:',
                  '# shellcheck source=/my-file.sh # specify the file to source',
                  '# shellcheck source-path=my_script_folder # specify the folder to search in',
                  '# shellcheck source=/dev/null # to ignore the error',
                  '',
                  'Disable this message by changing the configuration option "enableSourceErrorDiagnostics"',
                ].join('\n'),
                LSP.DiagnosticSeverity.Information,
                undefined,
                'bash-language-server',
              ),
            )
          }
        })
    }

    if (tree.rootNode.hasError()) {
      logger.warn(`Error while parsing ${uri}: syntax error`)
    }

    return diagnostics
  }

  /**
   * Initiates a background analysis of the files in the workspaceFolder to
   * enable features across files.
   *
   * NOTE that when the source aware feature is enabled files are also parsed
   * when they are found.
   */
  public async initiateBackgroundAnalysis({
    backgroundAnalysisMaxFiles,
    globPattern,
  }: {
    backgroundAnalysisMaxFiles: number
    globPattern: string
  }): Promise<{ filesParsed: number }> {
    const rootPath = this.workspaceFolder
    if (!rootPath) {
      return { filesParsed: 0 }
    }

    if (backgroundAnalysisMaxFiles <= 0) {
      logger.info(`BackgroundAnalysis: skipping as backgroundAnalysisMaxFiles was 0...`)
      return { filesParsed: 0 }
    }

    logger.info(
      `BackgroundAnalysis: resolving glob "${globPattern}" inside "${rootPath}"...`,
    )

    const lookupStartTime = Date.now()
    const getTimePassed = (): string => `${(Date.now() - lookupStartTime) / 1000} seconds`

    let filePaths: string[] = []
    try {
      filePaths = await getFilePaths({
        globPattern,
        rootPath,
        maxItems: backgroundAnalysisMaxFiles,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : error
      logger.warn(
        `BackgroundAnalysis: failed resolved glob "${globPattern}". The experience across files will be degraded. Error: ${errorMessage}`,
      )
      return { filesParsed: 0 }
    }

    logger.info(
      `BackgroundAnalysis: Glob resolved with ${
        filePaths.length
      } files after ${getTimePassed()}`,
    )

    for (const filePath of filePaths) {
      const uri = url.pathToFileURL(filePath).href

      try {
        const fileContent = await fs.promises.readFile(filePath, 'utf8')
        const { shebang, shellDialect } = analyzeShebang(fileContent)
        if (shebang && !shellDialect) {
          logger.info(
            `BackgroundAnalysis: Skipping file ${uri} with shebang "${shebang}"`,
          )
          continue
        }

        this.analyze({
          document: TextDocument.create(uri, 'shell', 1, fileContent),
          uri,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : error
        logger.warn(`BackgroundAnalysis: Failed analyzing ${uri}. Error: ${errorMessage}`)
      }
    }

    logger.info(`BackgroundAnalysis: Completed after ${getTimePassed()}.`)
    return {
      filesParsed: filePaths.length,
    }
  }

  /**
   * Find all the locations where the word was declared.
   */
  public findDeclarationLocations({
    position,
    uri,
    word,
  }: {
    position: LSP.Position
    uri: string
    word: string
  }): LSP.Location[] {
    // If the word is sourced, return the location of the source file
    const sourcedUri = this.uriToAnalyzedDocument[uri]?.sourceCommands
      .filter((sourceCommand) => isPositionIncludedInRange(position, sourceCommand.range))
      .map((sourceCommand) => sourceCommand.uri)[0]

    if (sourcedUri) {
      return [LSP.Location.create(sourcedUri, LSP.Range.create(0, 0, 0, 0))]
    }

    return this.findDeclarationsMatchingWord({
      exactMatch: true,
      position,
      uri,
      word,
    }).map((symbol) => symbol.location)
  }

  /**
   * Find all the declaration symbols in the workspace matching the query using fuzzy search.
   */
  public findDeclarationsWithFuzzySearch(query: string): LSP.SymbolInformation[] {
    const searcher = new FuzzySearch(this.getAllDeclarations(), ['name'], {
      caseSensitive: true,
    })
    return searcher.search(query)
  }

  /**
   * Find declarations for the given word and position.
   */
  public findDeclarationsMatchingWord({
    exactMatch,
    position,
    uri,
    word,
  }: {
    exactMatch: boolean
    position: LSP.Position
    uri: string
    word: string
  }): LSP.SymbolInformation[] {
    return this.getAllDeclarations({ uri, position }).filter((symbol) => {
      if (exactMatch) {
        return symbol.name === word
      } else {
        return symbol.name.startsWith(word)
      }
    })
  }

  /**
   * Find a symbol's original declaration with respect to its scope.
   */
  public findOriginalDeclaration({
    position,
    uri,
    word,
    type,
  }: {
    position: LSP.Position
    uri: string
    word: string
    type: 'variable' | 'function'
  }): LSP.Location | null {
    const node = this.nodeAtPoint(uri, position.line, position.character)

    if (!node) {
      return null
    }

    let originalDeclaration: Parser.SyntaxNode | null | undefined

    // TODO: Handle var="$var" cases
    let parent = this.findParentScopeNode(uri, node.startPosition, node.endPosition)
    let continueSearching = false
    let boundary = position.line
    while (parent) {
      if (
        type === 'variable' &&
        parent.type === 'function_definition' &&
        parent.lastChild
      ) {
        const functionBody = parent.lastChild
        TreeSitterUtil.forEach(functionBody, (n) => {
          if (
            (originalDeclaration && !continueSearching) ||
            n.startPosition.row > boundary ||
            n.type === 'function_definition' ||
            n.type === 'subshell'
          ) {
            return false
          }

          const isLocal =
            n.firstChild && ['local', 'declare', 'typeset'].includes(n.firstChild.text)
          const variable = n.descendantsOfType('variable_name').at(0)
          if (n.type === 'declaration_command' && isLocal && variable?.text === word) {
            originalDeclaration = variable
            continueSearching = false
          }

          return true
        })
      } else if (parent.type === 'subshell') {
        TreeSitterUtil.forEach(parent, (n) => {
          if (
            (originalDeclaration && !continueSearching) ||
            n.startPosition.row > boundary ||
            (n.type === 'subshell' && !parent?.equals(n))
          ) {
            return false
          }

          let node: Parser.SyntaxNode | null | undefined
          let nodeText: string | undefined

          switch (type) {
            case 'variable':
              if (
                n.type === 'declaration_command' ||
                n.type === 'for_statement' ||
                (n.type === 'command' && n.text.includes(':='))
              ) {
                node = n.descendantsOfType('variable_name').at(0)
                nodeText = node?.text
              } else if (n.type === 'variable_assignment') {
                node = n.firstNamedChild
                nodeText = node?.text
              }
              break

            case 'function':
              if (n.type === 'function_definition') {
                node = n.firstNamedChild
                nodeText = node?.text
              }
              break
          }

          if (nodeText === word) {
            originalDeclaration = node
            continueSearching = n.type === 'command'
          }

          if (n.type === 'function_definition') {
            return false
          }

          return true
        })
      }

      if (originalDeclaration && !continueSearching) {
        break
      }

      boundary = parent.startPosition.row
      parent = this.findParentScopeNode(uri, parent.startPosition, parent.endPosition)
    }

    // TODO: Handle global definitions

    // TODO: Return LSP.SymbolInformation to help differentiate between local
    // and global definitions using .containerName
    return originalDeclaration
      ? LSP.Location.create(uri, TreeSitterUtil.range(originalDeclaration))
      : null
  }

  /**
   * Find all the locations where the given word was defined or referenced.
   * This will include commands, functions, variables, etc.
   *
   * It's currently not scope-aware, see findOccurrences.
   */
  public findReferences(word: string): LSP.Location[] {
    const uris = Object.keys(this.uriToAnalyzedDocument)
    return flattenArray(uris.map((uri) => this.findOccurrences(uri, word)))
  }

  /**
   * Find all occurrences of a word in the given file.
   * It's currently not scope-aware.
   *
   * This will include commands, functions, variables, etc.
   *
   * It's currently not scope-aware, meaning references does include
   * references to functions and variables that has the same name but
   * are defined in different files.
   */
  public findOccurrences(uri: string, word: string): LSP.Location[] {
    const analyzedDocument = this.uriToAnalyzedDocument[uri]
    if (!analyzedDocument) {
      return []
    }

    const { tree } = analyzedDocument

    const locations: LSP.Location[] = []

    TreeSitterUtil.forEach(tree.rootNode, (n) => {
      let namedNode: Parser.SyntaxNode | null = null

      if (TreeSitterUtil.isReference(n)) {
        // NOTE: a reference can be a command, variable, function, etc.
        namedNode = n.firstNamedChild || n
      } else if (TreeSitterUtil.isDefinition(n)) {
        namedNode = n.firstNamedChild
      }

      if (namedNode && namedNode.text === word) {
        const range = TreeSitterUtil.range(namedNode)

        const alreadyInLocations = locations.some((loc) => {
          return isDeepStrictEqual(loc.range, range)
        })

        if (!alreadyInLocations) {
          locations.push(LSP.Location.create(uri, range))
        }
      }
    })

    return locations
  }

  // TODO: Handle non scoped occurrences
  // TODO: Handle functions
  public findOccurrencesWithin({
    uri,
    word,
    start,
    scope,
  }: {
    uri: string
    word: string
    start: LSP.Position
    scope: LSP.Range
  }): LSP.Range[] {
    const baseNode = this.nodeAtPoints(
      uri,
      { row: scope.start.line, column: scope.start.character },
      { row: scope.end.line, column: scope.end.character },
    )

    if (!baseNode) {
      return []
    }

    const ignoredRanges: LSP.Range[] = []

    return baseNode
      .descendantsOfType('variable_name', { row: start.line, column: start.character })
      .filter((n) => {
        if (n.text !== word) {
          return false
        }

        const parentScope = this.findParentScopeNode(uri, n.startPosition, n.endPosition)
        const parentDeclaration = TreeSitterUtil.findParentOfType(
          n,
          parentScope?.type === 'function_definition'
            ? 'declaration_command'
            : 'variable_assignment',
        )
        const firstInstance = parentDeclaration?.descendantsOfType('variable_name')?.at(0)

        // Special handling for var="$var" cases
        if (firstInstance?.text === word && !n.equals(firstInstance)) {
          // `start.line` is assumed to be the same as the variable's original
          // declaration line.
          if (parentDeclaration?.startPosition.row === start.line) {
            return false
          }

          // Returning true here is a good enough heuristic for most cases. It
          // breaks down when redeclaration happens in multiple nested scopes,
          // handling those more complex situations can be done later on if use
          // cases arise.
          return true
        }

        if (!parentScope || baseNode.equals(parentScope)) {
          return true
        }

        const includeInstance = !ignoredRanges.some(
          (r) => n.startPosition.row > r.start.line && n.endPosition.row < r.end.line,
        )

        if (!parentDeclaration) {
          return includeInstance
        }

        const isLocalDeclaration =
          firstInstance?.text === word &&
          (parentScope.type === 'subshell'
            ? !!parentDeclaration
            : ['local', 'declare', 'typeset'].includes(
                parentDeclaration.firstChild?.text ?? '',
              ))
        if (isLocalDeclaration) {
          if (includeInstance) {
            ignoredRanges.push(TreeSitterUtil.range(parentScope))
          }

          return false
        }

        return true
      })
      .map((n) => TreeSitterUtil.range(n))
  }

  /**
   * Find the parent function or subshell scope of the given range.
   */
  public findParentScope(
    uri: string,
    start: LSP.Position,
    end: LSP.Position,
  ): { range: LSP.Range; type: 'function' | 'subshell' } | null {
    const parent = this.findParentScopeNode(
      uri,
      { row: start.line, column: start.character },
      { row: end.line, column: end.character },
    )

    if (!parent) {
      return null
    }

    return {
      range: TreeSitterUtil.range(parent),
      type: parent.type === 'function_definition' ? 'function' : 'subshell',
    }
  }

  public getAllVariables({
    position,
    uri,
  }: {
    position: LSP.Position
    uri: string
  }): LSP.SymbolInformation[] {
    return this.getAllDeclarations({ uri, position }).filter(
      (symbol) => symbol.kind === LSP.SymbolKind.Variable,
    )
  }

  /**
   * Get all symbol declarations in the given file. This is used for generating an outline.
   *
   * TODO: convert to DocumentSymbol[] which is a hierarchy of symbols found in a given text document.
   */
  public getDeclarationsForUri({ uri }: { uri: string }): LSP.SymbolInformation[] {
    const tree = this.uriToAnalyzedDocument[uri]?.tree

    if (!tree?.rootNode) {
      return []
    }

    return getAllDeclarationsInTree({ uri, tree })
  }

  /**
   * Get the document for the given URI.
   */
  public getDocument(uri: string): TextDocument | undefined {
    return this.uriToAnalyzedDocument[uri]?.document
  }

  // TODO: move somewhere else than the analyzer...
  public async getExplainshellDocumentation({
    params,
    endpoint,
  }: {
    params: LSP.TextDocumentPositionParams
    endpoint: string
  }): Promise<{ helpHTML?: string }> {
    const analyzedDocument = this.uriToAnalyzedDocument[params.textDocument.uri]

    const leafNode = analyzedDocument?.tree.rootNode.descendantForPosition({
      row: params.position.line,
      column: params.position.character,
    })

    if (!leafNode || !analyzedDocument) {
      return {}
    }

    // explainshell needs the whole command, not just the "word" (tree-sitter
    // parlance) that the user hovered over. A relatively successful heuristic
    // is to simply go up one level in the AST. If you go up too far, you'll
    // start to include newlines, and explainshell completely balks when it
    // encounters newlines.
    const interestingNode = leafNode.type === 'word' ? leafNode.parent : leafNode

    if (!interestingNode) {
      return {}
    }

    type ExplainshellResponse = {
      matches?: Array<{ helpHTML: string; start: number; end: number }>
    }

    const searchParams = new URLSearchParams({ cmd: interestingNode.text }).toString()
    const url = `${endpoint}/api/explain?${searchParams}`

    const explainshellRawResponse = await fetch(url)
    const explainshellResponse =
      (await explainshellRawResponse.json()) as ExplainshellResponse

    if (!explainshellRawResponse.ok) {
      throw new Error(`HTTP request failed: ${url}`)
    } else if (!explainshellResponse.matches) {
      return {}
    } else {
      const offsetOfMousePointerInCommand =
        analyzedDocument.document.offsetAt(params.position) - interestingNode.startIndex

      const match = explainshellResponse.matches.find(
        (helpItem) =>
          helpItem.start <= offsetOfMousePointerInCommand &&
          offsetOfMousePointerInCommand < helpItem.end,
      )

      return { helpHTML: match && match.helpHTML }
    }
  }

  /**
   * Find the name of the command at the given point.
   */
  public commandNameAtPoint(uri: string, line: number, column: number): string | null {
    let node = this.nodeAtPoint(uri, line, column)

    while (node && node.type !== 'command') {
      node = node.parent
    }

    if (!node) {
      return null
    }

    const firstChild = node.firstNamedChild

    if (!firstChild || firstChild.type !== 'command_name') {
      return null
    }

    return firstChild.text.trim()
  }

  /**
   * Find a block of comments above a line position
   */
  public commentsAbove(uri: string, line: number): string | null {
    const doc = this.uriToAnalyzedDocument[uri]?.document
    if (!doc) {
      return null
    }

    const commentBlock = []

    // start from the line above
    let commentBlockIndex = line - 1

    // will return the comment string without the comment '#'
    // and without leading whitespace, or null if the line 'l'
    // is not a comment line
    const getComment = (l: string): null | string => {
      // this regexp has to be defined within the function
      const commentRegExp = /^\s*#\s?(.*)/g
      const matches = commentRegExp.exec(l)
      return matches ? matches[1].trimRight() : null
    }

    let currentLine = doc.getText({
      start: { line: commentBlockIndex, character: 0 },
      end: { line: commentBlockIndex + 1, character: 0 },
    })

    // iterate on every line above and including
    // the current line until getComment returns null
    let currentComment: string | null = ''
    while ((currentComment = getComment(currentLine)) !== null) {
      commentBlock.push(currentComment)
      commentBlockIndex -= 1
      currentLine = doc.getText({
        start: { line: commentBlockIndex, character: 0 },
        end: { line: commentBlockIndex + 1, character: 0 },
      })
    }

    if (commentBlock.length) {
      commentBlock.push('```txt')
      // since we searched from bottom up, we then reverse
      // the lines so that it reads top down.
      commentBlock.reverse()
      commentBlock.push('```')
      return commentBlock.join('\n')
    }

    // no comments found above line:
    return null
  }

  /**
   * Find the full word at the given point.
   */
  public wordAtPoint(uri: string, line: number, column: number): string | null {
    const node = this.nodeAtPoint(uri, line, column)

    if (!node || node.childCount > 0 || node.text.trim() === '') {
      return null
    }

    return node.text.trim()
  }

  public wordAtPointFromTextPosition(
    params: LSP.TextDocumentPositionParams,
  ): string | null {
    return this.wordAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )
  }

  public symbolAtPointFromTextPosition(
    params: LSP.TextDocumentPositionParams,
  ): { word: string; range: LSP.Range; type: 'variable' | 'function' } | null {
    const node = this.nodeAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )

    if (!node) {
      return null
    }

    if (
      node.type === 'variable_name' ||
      (node.type === 'word' &&
        node.parent &&
        (node.parent.type === 'function_definition' ||
          node.parent.type === 'command_name'))
    ) {
      return {
        word: node.text,
        range: TreeSitterUtil.range(node),
        type: node.type === 'variable_name' ? 'variable' : 'function',
      }
    }

    return null
  }

  public setEnableSourceErrorDiagnostics(enableSourceErrorDiagnostics: boolean): void {
    this.enableSourceErrorDiagnostics = enableSourceErrorDiagnostics
  }

  public setIncludeAllWorkspaceSymbols(includeAllWorkspaceSymbols: boolean): void {
    this.includeAllWorkspaceSymbols = includeAllWorkspaceSymbols
  }

  // Private methods

  /**
   * Returns all reachable URIs from the given URI based on sourced commands
   * If no URI is given, all URIs from the background analysis are returned.
   * If the includeAllWorkspaceSymbols flag is set, all URIs from the background analysis are also included.
   */
  private getReachableUris({ fromUri }: { fromUri?: string } = {}): string[] {
    if (!fromUri) {
      return Object.keys(this.uriToAnalyzedDocument)
    }

    const urisBasedOnSourcing = [
      fromUri,
      ...Array.from(this.findAllSourcedUris({ uri: fromUri })),
    ]

    if (this.includeAllWorkspaceSymbols) {
      return Array.from(
        new Set([...urisBasedOnSourcing, ...Object.keys(this.uriToAnalyzedDocument)]),
      )
    } else {
      return urisBasedOnSourcing
    }
  }

  private getAnalyzedReachableUris({ fromUri }: { fromUri?: string } = {}): string[] {
    return this.ensureUrisAreAnalyzed(this.getReachableUris({ fromUri }))
  }

  private ensureUrisAreAnalyzed(uris: string[]): string[] {
    return uris.filter((uri) => {
      if (!this.uriToAnalyzedDocument[uri]) {
        // Either the background analysis didn't run or the file is outside
        // the workspace. Let us try to analyze the file.
        try {
          logger.debug(`Analyzing file not covered by background analysis ${uri}`)
          const fileContent = fs.readFileSync(new URL(uri), 'utf8')
          this.analyze({
            document: TextDocument.create(uri, 'shell', 1, fileContent),
            uri,
          })
        } catch (err) {
          logger.warn(`Error while analyzing file ${uri}: ${err}`)
          return false
        }
      }

      return true
    })
  }

  /**
   * Get all declaration symbols (function or variables) from the given file/position
   * or from all files in the workspace. It will take into account the given position
   * to filter out irrelevant symbols.
   *
   * Note that this can return duplicates across the workspace.
   */
  private getAllDeclarations({
    uri: fromUri,
    position,
  }: { uri?: string; position?: LSP.Position } = {}): LSP.SymbolInformation[] {
    return this.getAnalyzedReachableUris({ fromUri }).reduce((symbols, uri) => {
      const analyzedDocument = this.uriToAnalyzedDocument[uri]

      if (analyzedDocument) {
        if (uri !== fromUri || !position) {
          // We use the global declarations for external files or if we do not have a position
          const { globalDeclarations } = analyzedDocument
          Object.values(globalDeclarations).forEach((symbol) => symbols.push(symbol))
        }

        // For the current file we find declarations based on the current scope
        if (uri === fromUri && position) {
          const node = analyzedDocument.tree.rootNode?.descendantForPosition({
            row: position.line,
            column: position.character,
          })

          const localDeclarations = getLocalDeclarations({
            node,
            rootNode: analyzedDocument.tree.rootNode,
            uri,
          })

          Object.keys(localDeclarations).map((name) => {
            const symbolsMatchingWord = localDeclarations[name]

            // Find the latest definition
            let closestSymbol: LSP.SymbolInformation | null = null
            symbolsMatchingWord.forEach((symbol) => {
              // Skip if the symbol is defined in the current file after the requested position
              if (symbol.location.range.start.line > position.line) {
                return
              }

              if (
                closestSymbol === null ||
                symbol.location.range.start.line > closestSymbol.location.range.start.line
              ) {
                closestSymbol = symbol
              }
            })

            if (closestSymbol) {
              symbols.push(closestSymbol)
            }
          })
        }
      }

      return symbols
    }, [] as LSP.SymbolInformation[])
  }

  public findAllSourcedUris({ uri }: { uri: string }): Set<string> {
    const allSourcedUris = new Set<string>([])

    const addSourcedFilesFromUri = (fromUri: string) => {
      const sourcedUris = this.uriToAnalyzedDocument[fromUri]?.sourcedUris

      if (!sourcedUris) {
        return
      }

      sourcedUris.forEach((sourcedUri) => {
        if (!allSourcedUris.has(sourcedUri)) {
          allSourcedUris.add(sourcedUri)
          addSourcedFilesFromUri(sourcedUri)
        }
      })
    }

    addSourcedFilesFromUri(uri)

    return allSourcedUris
  }

  private findParentScopeNode(
    uri: string,
    start: Parser.Point,
    end: Parser.Point,
  ): Parser.SyntaxNode | null {
    const node = this.nodeAtPoints(uri, start, end)

    if (!node) {
      return null
    }

    const parent = TreeSitterUtil.findParent(
      node,
      (n) =>
        n.type === 'subshell' ||
        (n.type === 'function_definition' && n.lastChild?.type !== 'subshell'),
    )

    if (!parent) {
      return null
    }

    return parent
  }

  /**
   * Find the node at the given point.
   */
  private nodeAtPoint(
    uri: string,
    line: number,
    column: number,
  ): Parser.SyntaxNode | null {
    const tree = this.uriToAnalyzedDocument[uri]?.tree

    if (!tree?.rootNode) {
      // Check for lacking rootNode (due to failed parse?)
      return null
    }

    return tree.rootNode.descendantForPosition({ row: line, column })
  }

  private nodeAtPoints(
    uri: string,
    start: Parser.Point,
    end: Parser.Point,
  ): Parser.SyntaxNode | null {
    const rootNode = this.uriToAnalyzedDocument[uri]?.tree?.rootNode

    if (!rootNode) {
      return null
    }

    return rootNode.descendantForPosition(start, end)
  }
}
