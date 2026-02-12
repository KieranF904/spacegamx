/**
 * Event Feed UI - Shows notable game events
 * 
 * Displays scrolling messages for:
 * - Enemy defeats
 * - Mission/Quest completion
 * - Level ups
 * - Loot/rare item drops
 * - Player joined/left
 * - Achievements
 */

export interface EventFeedEntry {
  id: number;
  type: 'enemy-defeat' | 'mission' | 'quest' | 'levelup' | 'loot' | 'join' | 'leave' | 'achievement' | 'system';
  player?: string;
  target?: string;
  item?: string;
  level?: number;
  message?: string;
  timestamp: number;
}

export class KillFeedUI {
  private container: HTMLElement;
  private feedEl: HTMLElement;
  private entries: EventFeedEntry[] = [];
  private nextId = 0;
  private readonly MAX_ENTRIES = 8;
  private readonly ENTRY_LIFETIME = 6000; // ms
  
  constructor(container: HTMLElement) {
    this.container = container;
    
    this.feedEl = document.createElement('div');
    this.feedEl.id = 'kill-feed';
    this.feedEl.className = 'ui-element';
    container.appendChild(this.feedEl);
    
    this.setupStyles();
    
    // Start cleanup timer
    setInterval(() => this.cleanup(), 1000);
  }
  
  private setupStyles(): void {
    const style = document.createElement('style');
    style.id = 'kill-feed-styles';
    
    // Remove old styles if they exist
    const oldStyle = document.getElementById('kill-feed-styles');
    if (oldStyle) oldStyle.remove();
    
    style.textContent = `
      #kill-feed {
        position: absolute;
        top: 120px;
        right: 20px;
        width: 300px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        pointer-events: none;
        z-index: 100;
        font-family: 'Rajdhani', 'Arial', sans-serif;
      }
      
      .kill-feed-entry {
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 13px;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 8px;
        animation: killFeedSlideIn 0.3s ease-out;
        border-left: 3px solid;
        transition: opacity 0.5s ease-out;
      }
      
      .kill-feed-entry.fading {
        opacity: 0;
      }
      
      @keyframes killFeedSlideIn {
        from {
          transform: translateX(50px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      
      .kill-feed-entry.type-enemy-defeat {
        border-color: #ff6644;
      }
      
      .kill-feed-entry.type-mission {
        border-color: #44aaff;
      }
      
      .kill-feed-entry.type-quest {
        border-color: #aa88ff;
      }
      
      .kill-feed-entry.type-levelup {
        border-color: #ffcc00;
      }
      
      .kill-feed-entry.type-loot {
        border-color: #44ff88;
      }
      
      .kill-feed-entry.type-join {
        border-color: #44ff44;
      }
      
      .kill-feed-entry.type-leave {
        border-color: #888888;
      }
      
      .kill-feed-entry.type-achievement {
        border-color: #ffcc00;
      }
      
      .kill-feed-entry.type-system {
        border-color: #88ccff;
      }
      
      .kill-feed-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }
      
      .event-player {
        color: #88ccff;
        font-weight: 600;
      }
      
      .event-target {
        color: #ff8866;
        font-weight: 600;
      }
      
      .event-item {
        color: #44ff88;
        font-weight: 600;
      }
      
      .event-level {
        color: #ffcc00;
        font-weight: 700;
      }
      
      .event-quest {
        color: #aa88ff;
      }
      
      .event-mission {
        color: #44aaff;
      }
      
      .kill-feed-join {
        color: #88ff88;
      }
      
      .kill-feed-leave {
        color: #888888;
      }
      
      .kill-feed-achievement {
        color: #ffcc00;
      }
    `;
    document.head.appendChild(style);
  }
  
  /**
   * Add enemy defeat event
   */
  addEnemyDefeat(player: string, enemy: string, isSelf = false): void {
    this.addEntry({
      id: this.nextId++,
      type: 'enemy-defeat',
      player,
      target: enemy,
      timestamp: Date.now(),
    }, isSelf);
  }
  
  /**
   * Add mission completion event
   */
  addMissionComplete(player: string, mission: string): void {
    this.addEntry({
      id: this.nextId++,
      type: 'mission',
      player,
      message: mission,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Add quest completion event
   */
  addQuestComplete(player: string, quest: string): void {
    this.addEntry({
      id: this.nextId++,
      type: 'quest',
      player,
      message: quest,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Add level up event
   */
  addLevelUp(player: string, level: number): void {
    this.addEntry({
      id: this.nextId++,
      type: 'levelup',
      player,
      level,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Add loot drop event
   */
  addLootDrop(player: string, item: string): void {
    this.addEntry({
      id: this.nextId++,
      type: 'loot',
      player,
      item,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Add player join notification
   */
  addJoin(player: string): void {
    this.addEntry({
      id: this.nextId++,
      type: 'join',
      message: player,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Add player leave notification
   */
  addLeave(player: string): void {
    this.addEntry({
      id: this.nextId++,
      type: 'leave',
      message: player,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Add achievement notification
   */
  addAchievement(player: string, achievement: string): void {
    this.addEntry({
      id: this.nextId++,
      type: 'achievement',
      message: `${player} earned "${achievement}"`,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Add system message
   */
  addSystemMessage(message: string): void {
    this.addEntry({
      id: this.nextId++,
      type: 'system',
      message,
      timestamp: Date.now(),
    });
  }
  
  private addEntry(entry: EventFeedEntry, isSelf = false): void {
    this.entries.unshift(entry);
    
    // Limit entries
    while (this.entries.length > this.MAX_ENTRIES) {
      this.entries.pop();
    }
    
    this.render(isSelf);
  }
  
  private render(highlightLatest = false): void {
    this.feedEl.innerHTML = this.entries.map((entry, index) => {
      const isLatest = index === 0 && highlightLatest;
      return this.renderEntry(entry, isLatest);
    }).join('');
  }
  
  private renderEntry(entry: EventFeedEntry, isLatest: boolean): string {
    const highlight = isLatest ? 'style="background: rgba(255, 100, 0, 0.2);"' : '';
    
    switch (entry.type) {
      case 'enemy-defeat':
        return `
          <div class="kill-feed-entry type-enemy-defeat" data-id="${entry.id}" ${highlight}>
            <span class="event-player">${this.escapeHtml(entry.player || 'Player')}</span>
            <span style="color: #666;">defeated</span>
            <span class="event-target">${this.escapeHtml(entry.target || 'enemy')}</span>
          </div>
        `;
        
      case 'mission':
        return `
          <div class="kill-feed-entry type-mission" data-id="${entry.id}" ${highlight}>
            <span class="event-player">${this.escapeHtml(entry.player || 'Player')}</span>
            <span style="color: #666;">completed</span>
            <span class="event-mission">${this.escapeHtml(entry.message || 'mission')}</span>
          </div>
        `;
        
      case 'quest':
        return `
          <div class="kill-feed-entry type-quest" data-id="${entry.id}" ${highlight}>
            <span class="event-player">${this.escapeHtml(entry.player || 'Player')}</span>
            <span style="color: #666;">completed quest:</span>
            <span class="event-quest">${this.escapeHtml(entry.message || '')}</span>
          </div>
        `;
        
      case 'levelup':
        return `
          <div class="kill-feed-entry type-levelup" data-id="${entry.id}" ${highlight}>
            <span class="event-player">${this.escapeHtml(entry.player || 'Player')}</span>
            <span style="color: #666;">reached level</span>
            <span class="event-level">${entry.level || 1}</span>
          </div>
        `;
        
      case 'loot':
        return `
          <div class="kill-feed-entry type-loot" data-id="${entry.id}" ${highlight}>
            <span class="event-player">${this.escapeHtml(entry.player || 'Player')}</span>
            <span style="color: #666;">found</span>
            <span class="event-item">${this.escapeHtml(entry.item || 'item')}</span>
          </div>
        `;
        
      case 'join':
        return `
          <div class="kill-feed-entry type-join" data-id="${entry.id}" ${highlight}>
            <span class="kill-feed-join">${this.escapeHtml(entry.message || 'Player')}</span>
            <span style="color: #666;">joined the game</span>
          </div>
        `;
        
      case 'leave':
        return `
          <div class="kill-feed-entry type-leave" data-id="${entry.id}" ${highlight}>
            <span class="kill-feed-leave">${this.escapeHtml(entry.message || 'Player')}</span>
            <span style="color: #666;">left the game</span>
          </div>
        `;
        
      case 'achievement':
        return `
          <div class="kill-feed-entry type-achievement" data-id="${entry.id}" ${highlight}>
            <span class="kill-feed-achievement">★ ${this.escapeHtml(entry.message || '')}</span>
          </div>
        `;
        
      case 'system':
        return `
          <div class="kill-feed-entry type-system" data-id="${entry.id}" ${highlight}>
            <span style="color: #88ccff;">${this.escapeHtml(entry.message || '')}</span>
          </div>
        `;
        
      default:
        return '';
    }
  }
  
  private cleanup(): void {
    const now = Date.now();
    const fadingEntries: number[] = [];
    
    // Mark old entries as fading
    this.entries.forEach(entry => {
      if (now - entry.timestamp > this.ENTRY_LIFETIME - 500) {
        fadingEntries.push(entry.id);
      }
    });
    
    // Add fading class
    fadingEntries.forEach(id => {
      const el = this.feedEl.querySelector(`[data-id="${id}"]`);
      if (el) el.classList.add('fading');
    });
    
    // Remove expired entries
    const oldLength = this.entries.length;
    this.entries = this.entries.filter(entry => 
      now - entry.timestamp < this.ENTRY_LIFETIME
    );
    
    if (this.entries.length !== oldLength) {
      this.render();
    }
  }
  
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  show(): void {
    this.feedEl.style.display = 'flex';
  }
  
  hide(): void {
    this.feedEl.style.display = 'none';
  }
  
  clear(): void {
    this.entries = [];
    this.render();
  }
}
