export interface ContextReference {
  type: 'file' | 'folder' | 'selection' | 'terminal' | 'documentation';
  name: string;
  uri?: string;
  tokenCountEstimate: number;
}

export interface ContextHealthScore {
  score: number; // 0-100
  historyBloatRatio: number; // Turn count vs useful resolution
  deadReferences: ContextReference[];
  warnings: string[];
}

export class CursorContextAnalyzer {
  private currentSessionTokens: number = 0;
  private turnCount: number = 0;
  private activeReferences = new Map<string, ContextReference>();

  /**
   * Called when a new user prompt is sent to Cursor.
   * Extracts @ mentions and attached files from the rich text payload.
   */
  public analyzeUserPrompt(promptText: string, richTextPayload?: string): void {
    this.turnCount++;
    this.extractReferences(promptText, richTextPayload);
  }

  /**
   * Analyzes an output delta from the agent to check if context dependencies 
   * are actually being utilized.
   */
  public analyzeOutput(agentOutput: string): void {
    // Basic heuristics: if the agent doesn't even mention the file name
    // or emit diffs against the file, it's potentially dead context.
  }

  /**
   * Calculates the overall health score of the context window.
   */
  public getHealthScore(): ContextHealthScore {
    const deadThreshold = 0.5; // Example logic placeholder
    let score = 100;

    const warnings: string[] = [];
    if (this.turnCount > 15) {
      score -= 20;
      warnings.push("Session history is too long. Consider starting fresh to restore reasoning efficiency.");
    }

    // In a real WAL implementation, we derive these from the diffs/output tracking.
    return {
      score: Math.max(0, score),
      historyBloatRatio: this.turnCount / 10,
      deadReferences: [],
      warnings
    };
  }

  private extractReferences(text: string, richTextPayload?: string): void {
    // In actual implementation, we will decode the Cursor protobuf here or 
    // parse the richText/userMessage objects exposed by the API to pinpoint files.
    
    // Fallback naive extraction
    const mentionRegex = /@([a-zA-Z0-9_\-\./]+)/g;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      const fileName = match[1];
      if (!this.activeReferences.has(fileName)) {
        this.activeReferences.set(fileName, {
          type: 'file',
          name: fileName,
          tokenCountEstimate: 500, // Placeholder
        });
      }
    }
  }
}
