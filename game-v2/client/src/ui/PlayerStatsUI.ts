/**
 * Player Stats Panel UI - Shows player statistics
 * 
 * Displays:
 * - Level & Experience progress
 * - Credits & Net worth
 * - Resources gathered
 * - Missions completed
 * - Enemies defeated
 * - Distance traveled
 * - Session time
 */

export interface PlayerStats {
  // Progression
  level: number;
  experience: number;
  experienceToNextLevel: number;
  
  // Economy
  credits: number;
  creditsEarned: number;
  creditsSpent: number;
  
  // Activity
  enemiesDefeated: number;
  missionsCompleted: number;
  questsCompleted: number;
  
  // Resources
  asteroidsMined: number;
  oreCollected: number;
  itemsCrafted: number;
  
  // Exploration
  systemsVisited: number;
  distanceTraveled: number;
  jumpsCompleted: number;
  
  // Session
  sessionStartTime: number;
  
  // Combat (less prominent)
  damageDealt: number;
  damageTaken: number;
  shotsHit: number;
  shotsFired: number;
}

export class PlayerStatsUI {
  private container: HTMLElement;
  private panelEl: HTMLElement;
  private visible = false;
  
  private stats: PlayerStats = {
    // Progression
    level: 1,
    experience: 0,
    experienceToNextLevel: 1000,
    
    // Economy
    credits: 0,
    creditsEarned: 0,
    creditsSpent: 0,
    
    // Activity
    enemiesDefeated: 0,
    missionsCompleted: 0,
    questsCompleted: 0,
    
    // Resources
    asteroidsMined: 0,
    oreCollected: 0,
    itemsCrafted: 0,
    
    // Exploration
    systemsVisited: 1,
    distanceTraveled: 0,
    jumpsCompleted: 0,
    
    // Session
    sessionStartTime: Date.now(),
    
    // Combat
    damageDealt: 0,
    damageTaken: 0,
    shotsHit: 0,
    shotsFired: 0,
  };
  
  constructor(container: HTMLElement) {
    this.container = container;
    
    this.panelEl = document.createElement('div');
    this.panelEl.id = 'player-stats-panel';
    this.panelEl.className = 'ui-element';
    container.appendChild(this.panelEl);
    
    this.setupStyles();
    this.render();
    
    // Update session time every second
    setInterval(() => {
      if (this.visible) this.render();
    }, 1000);
  }
  
  private setupStyles(): void {
    const style = document.createElement('style');
    style.id = 'player-stats-styles';
    
    // Remove old styles if they exist
    const oldStyle = document.getElementById('player-stats-styles');
    if (oldStyle) oldStyle.remove();
    
    style.textContent = `
      #player-stats-panel {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 450px;
        background: rgba(0, 10, 30, 0.95);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(100, 180, 255, 0.3);
        border-radius: 12px;
        padding: 0;
        z-index: 1500;
        font-family: 'Rajdhani', 'Arial', sans-serif;
        display: none;
        box-shadow: 0 0 40px rgba(0, 100, 200, 0.2);
      }
      
      #player-stats-panel.visible {
        display: block;
        animation: statsSlideIn 0.2s ease-out;
      }
      
      @keyframes statsSlideIn {
        from {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      }
      
      .stats-header {
        background: linear-gradient(180deg, rgba(50, 100, 200, 0.3) 0%, transparent 100%);
        padding: 16px 20px;
        border-bottom: 1px solid rgba(100, 180, 255, 0.2);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .stats-title {
        font-size: 18px;
        font-weight: 600;
        color: #88ccff;
        letter-spacing: 2px;
        text-transform: uppercase;
      }
      
      .stats-close {
        width: 28px;
        height: 28px;
        border: none;
        background: rgba(255, 100, 100, 0.1);
        border-radius: 4px;
        color: #ff6666;
        font-size: 18px;
        cursor: pointer;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .stats-close:hover {
        background: rgba(255, 100, 100, 0.3);
      }
      
      .stats-content {
        padding: 20px;
      }
      
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
      }
      
      .stat-card {
        background: rgba(0, 30, 60, 0.5);
        border: 1px solid rgba(100, 180, 255, 0.1);
        border-radius: 8px;
        padding: 14px;
        transition: all 0.2s;
      }
      
      .stat-card:hover {
        background: rgba(0, 40, 80, 0.5);
        border-color: rgba(100, 180, 255, 0.3);
      }
      
      .stat-card.highlight {
        border-color: rgba(255, 200, 100, 0.3);
        background: rgba(40, 30, 0, 0.3);
      }
      
      .stat-label {
        font-size: 11px;
        color: rgba(150, 200, 255, 0.6);
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 6px;
      }
      
      .stat-value {
        font-size: 24px;
        font-weight: 700;
        color: #fff;
      }
      
      .stat-value.positive {
        color: #66ff88;
      }
      
      .stat-value.negative {
        color: #ff6666;
      }
      
      .stat-value.neutral {
        color: #88ccff;
      }
      
      .stat-subtext {
        font-size: 11px;
        color: rgba(150, 200, 255, 0.4);
        margin-top: 4px;
      }
      
      .stats-divider {
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(100, 180, 255, 0.2), transparent);
        margin: 16px 0;
      }
      
      .stats-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px solid rgba(100, 180, 255, 0.1);
      }
      
      .stats-row:last-child {
        border-bottom: none;
      }
      
      .stats-row-label {
        font-size: 13px;
        color: rgba(150, 200, 255, 0.7);
      }
      
      .stats-row-value {
        font-size: 14px;
        font-weight: 600;
        color: #fff;
      }
      
      .level-display {
        font-size: 28px;
        font-weight: 700;
        color: #ffcc00;
      }
      
      .xp-bar {
        width: 100%;
        height: 6px;
        background: rgba(0, 0, 0, 0.4);
        border-radius: 3px;
        margin-top: 8px;
        overflow: hidden;
      }
      
      .xp-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #4488ff, #88ccff);
        border-radius: 3px;
        transition: width 0.3s ease;
      }
      
      .session-time {
        font-size: 20px;
        color: #88ccff;
        font-variant-numeric: tabular-nums;
      }
      
      .stats-section-title {
        font-size: 12px;
        color: rgba(150, 200, 255, 0.5);
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 8px;
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);
  }
  
  private render(): void {
    const xpPercent = Math.min(100, (this.stats.experience / this.stats.experienceToNextLevel) * 100);
    
    const accuracy = this.stats.shotsFired > 0
      ? Math.round((this.stats.shotsHit / this.stats.shotsFired) * 100)
      : 0;
      
    const sessionTime = this.formatTime(Date.now() - this.stats.sessionStartTime);
    
    this.panelEl.innerHTML = `
      <div class="stats-header">
        <span class="stats-title">Pilot Statistics</span>
        <button class="stats-close">✕</button>
      </div>
      <div class="stats-content">
        <div class="stats-grid">
          <div class="stat-card highlight">
            <div class="stat-label">Pilot Level</div>
            <div class="stat-value level-display">${this.stats.level}</div>
            <div class="xp-bar"><div class="xp-bar-fill" style="width: ${xpPercent}%"></div></div>
            <div class="stat-subtext">${this.formatNumber(this.stats.experience)} / ${this.formatNumber(this.stats.experienceToNextLevel)} XP</div>
          </div>
          
          <div class="stat-card highlight">
            <div class="stat-label">Credits</div>
            <div class="stat-value positive">${this.formatNumber(this.stats.credits)}</div>
            <div class="stat-subtext">Earned: ${this.formatNumber(this.stats.creditsEarned)}</div>
          </div>
          
          <div class="stat-card">
            <div class="stat-label">Missions Complete</div>
            <div class="stat-value neutral">${this.stats.missionsCompleted}</div>
          </div>
          
          <div class="stat-card">
            <div class="stat-label">Quests Complete</div>
            <div class="stat-value neutral">${this.stats.questsCompleted}</div>
          </div>
          
          <div class="stat-card">
            <div class="stat-label">Enemies Defeated</div>
            <div class="stat-value positive">${this.formatNumber(this.stats.enemiesDefeated)}</div>
          </div>
          
          <div class="stat-card">
            <div class="stat-label">Asteroids Mined</div>
            <div class="stat-value neutral">${this.stats.asteroidsMined}</div>
          </div>
        </div>
        
        <div class="stats-divider"></div>
        <div class="stats-section-title">Exploration</div>
        
        <div class="stats-row">
          <span class="stats-row-label">Systems Visited</span>
          <span class="stats-row-value">${this.stats.systemsVisited}</span>
        </div>
        
        <div class="stats-row">
          <span class="stats-row-label">Jump Gates Used</span>
          <span class="stats-row-value">${this.stats.jumpsCompleted}</span>
        </div>
        
        <div class="stats-row">
          <span class="stats-row-label">Distance Traveled</span>
          <span class="stats-row-value">${this.formatDistance(this.stats.distanceTraveled)}</span>
        </div>
        
        <div class="stats-divider"></div>
        <div class="stats-section-title">Combat</div>
        
        <div class="stats-row">
          <span class="stats-row-label">Accuracy</span>
          <span class="stats-row-value">${accuracy}%</span>
        </div>
        
        <div class="stats-row">
          <span class="stats-row-label">Damage Dealt</span>
          <span class="stats-row-value">${this.formatNumber(this.stats.damageDealt)}</span>
        </div>
        
        <div class="stats-divider"></div>
        
        <div class="stats-row">
          <span class="stats-row-label">Session Time</span>
          <span class="stats-row-value session-time">${sessionTime}</span>
        </div>
      </div>
    `;
    
    // Add close button handler
    const closeBtn = this.panelEl.querySelector('.stats-close');
    closeBtn?.addEventListener('click', () => this.hide());
  }
  
  private formatDistance(units: number): string {
    if (units >= 1000000) return (units / 1000000).toFixed(1) + ' Mm';
    if (units >= 1000) return (units / 1000).toFixed(1) + ' km';
    return Math.round(units) + ' m';
  }
  
  private formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return Math.round(num).toString();
  }
  
  private formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
  
  // Stat update methods
  
  // Progression
  addExperience(amount: number): void {
    this.stats.experience += amount;
    while (this.stats.experience >= this.stats.experienceToNextLevel) {
      this.stats.experience -= this.stats.experienceToNextLevel;
      this.stats.level++;
      this.stats.experienceToNextLevel = Math.floor(this.stats.experienceToNextLevel * 1.15);
    }
    if (this.visible) this.render();
  }
  
  setLevel(level: number, experience: number, experienceToNextLevel: number): void {
    this.stats.level = level;
    this.stats.experience = experience;
    this.stats.experienceToNextLevel = experienceToNextLevel;
    if (this.visible) this.render();
  }
  
  // Economy
  setCredits(amount: number): void {
    this.stats.credits = amount;
    if (this.visible) this.render();
  }
  
  addCreditsEarned(amount: number): void {
    this.stats.creditsEarned += amount;
    this.stats.credits += amount;
  }
  
  addCreditsSpent(amount: number): void {
    this.stats.creditsSpent += amount;
    this.stats.credits -= amount;
  }
  
  // Activity
  addEnemyDefeated(): void {
    this.stats.enemiesDefeated++;
    if (this.visible) this.render();
  }
  
  addMissionCompleted(): void {
    this.stats.missionsCompleted++;
    if (this.visible) this.render();
  }
  
  addQuestCompleted(): void {
    this.stats.questsCompleted++;
    if (this.visible) this.render();
  }
  
  // Resources
  addAsteroidMined(): void {
    this.stats.asteroidsMined++;
  }
  
  addOreCollected(amount: number): void {
    this.stats.oreCollected += amount;
  }
  
  addItemCrafted(): void {
    this.stats.itemsCrafted++;
  }
  
  // Exploration
  visitSystem(): void {
    this.stats.systemsVisited++;
  }
  
  addDistance(distance: number): void {
    this.stats.distanceTraveled += distance;
  }
  
  addJumpCompleted(): void {
    this.stats.jumpsCompleted++;
  }
  
  // Combat
  addDamageDealt(amount: number): void {
    this.stats.damageDealt += amount;
  }
  
  addDamageTaken(amount: number): void {
    this.stats.damageTaken += amount;
  }
  
  addShotFired(): void {
    this.stats.shotsFired++;
  }
  
  addShotHit(): void {
    this.stats.shotsHit++;
  }
  
  getStats(): PlayerStats {
    return { ...this.stats };
  }
  
  resetStats(): void {
    this.stats = {
      level: 1,
      experience: 0,
      experienceToNextLevel: 1000,
      credits: 0,
      creditsEarned: 0,
      creditsSpent: 0,
      enemiesDefeated: 0,
      missionsCompleted: 0,
      questsCompleted: 0,
      asteroidsMined: 0,
      oreCollected: 0,
      itemsCrafted: 0,
      systemsVisited: 1,
      distanceTraveled: 0,
      jumpsCompleted: 0,
      sessionStartTime: Date.now(),
      damageDealt: 0,
      damageTaken: 0,
      shotsHit: 0,
      shotsFired: 0,
    };
    if (this.visible) this.render();
  }
  
  show(): void {
    this.visible = true;
    this.panelEl.classList.add('visible');
    this.render();
  }
  
  hide(): void {
    this.visible = false;
    this.panelEl.classList.remove('visible');
  }
  
  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }
  
  isVisible(): boolean {
    return this.visible;
  }
}
