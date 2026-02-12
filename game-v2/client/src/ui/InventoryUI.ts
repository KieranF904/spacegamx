/**
 * Inventory UI - Persistent inventory bar and equipment panel
 * 
 * Redesigned to match the mock interface with:
 * - Horizontal inventory bar at bottom center (always visible when playing)
 * - Vertical equipment panel on left side
 * - Modern glass-morphism styling with rounded corners and blur effects
 */

import { InventorySlot, EquipmentSlots } from '@space-game/common';
import { ITEM_DATA, RARITY_COLORS, TIER_COLORS, getItemIcon, ItemInfo } from '../data/itemData';

export class InventoryUI {
  private container: HTMLElement;
  private inventoryPanel: HTMLElement;
  private equipmentPanel: HTMLElement;
  private tooltip: HTMLElement;
  private dragGhost: HTMLElement;
  private dropZone: HTMLElement;
  private visible = false;
  
  private inventory: InventorySlot[] = [];
  private equipment: EquipmentSlots = {
    leftWeapon: null,
    rightWeapon: null,
    booster: null,
    cockpit: null,
  };
  
  // Drag and drop
  private draggedSlot: { type: 'inventory' | 'equipment'; index: number | string } | null = null;
  private isDragging = false;
  
  // Callbacks
  public onEquip: ((inventorySlot: number, equipSlot: string) => void) | null = null;
  public onUnequip: ((equipSlot: string) => void) | null = null;
  public onSwapInventory: ((from: number, to: number) => void) | null = null;
  public onDropItem: ((slot: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    
    // Create inventory panel (bottom center bar)
    this.inventoryPanel = document.createElement('div');
    this.inventoryPanel.id = 'inventoryPanel';
    this.inventoryPanel.style.display = 'none';
    
    for (let i = 0; i < 10; i++) {
      const slot = document.createElement('div');
      slot.className = 'inv-slot';
      slot.dataset.slot = i.toString();
      this.inventoryPanel.appendChild(slot);
    }
    container.appendChild(this.inventoryPanel);
    
    // Create equipment panel (left side)
    this.equipmentPanel = document.createElement('div');
    this.equipmentPanel.id = 'equipmentPanel';
    this.equipmentPanel.style.display = 'none';
    
    const equipSlots = [
      { slot: 'leftWeapon', label: 'LMB', type: 'weapon' },
      { slot: 'rightWeapon', label: 'RMB', type: 'weapon' },
      { slot: 'booster', label: 'Boost', type: 'booster' },
      { slot: 'cockpit', label: 'Cockpit', type: 'cockpit' },
    ];
    
    for (const { slot, label, type } of equipSlots) {
      const slotEl = document.createElement('div');
      slotEl.className = 'equip-slot';
      slotEl.dataset.slot = slot;
      slotEl.dataset.type = type;
      slotEl.innerHTML = `<span class="slot-label">${label}</span>`;
      this.equipmentPanel.appendChild(slotEl);
    }
    container.appendChild(this.equipmentPanel);
    
    // Create tooltip
    this.tooltip = document.createElement('div');
    this.tooltip.id = 'itemTooltip';
    container.appendChild(this.tooltip);
    
    // Create drag ghost
    this.dragGhost = document.createElement('div');
    this.dragGhost.id = 'dragGhost';
    container.appendChild(this.dragGhost);
    
    // Create drop zone (for discarding items)
    this.dropZone = document.createElement('div');
    this.dropZone.id = 'dropZone';
    this.dropZone.textContent = 'DROP TO DISCARD';
    container.appendChild(this.dropZone);
    
    this.setupStyles();
    this.setupEventListeners();
  }

  private setupStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      /* ============================================
         INVENTORY BAR - Bottom Center
         ============================================ */
      #inventoryPanel {
        position: absolute;
        bottom: 60px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        gap: 6px;
        padding: 10px 14px;
        border-radius: 14px;
        background: rgba(6, 10, 24, 0.85);
        border: 1px solid rgba(120, 160, 220, 0.3);
        backdrop-filter: blur(10px);
        z-index: 20;
        animation: slideUp 0.3s ease-out;
        box-shadow: 0 4px 20px rgba(0, 20, 60, 0.4);
        pointer-events: auto;
      }
      
      @keyframes slideUp {
        from { 
          opacity: 0; 
          transform: translateX(-50%) translateY(20px); 
        }
        to { 
          opacity: 1; 
          transform: translateX(-50%) translateY(0); 
        }
      }
      
      /* ============================================
         EQUIPMENT PANEL - Left Side
         ============================================ */
      #equipmentPanel {
        position: absolute;
        left: 16px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px;
        border-radius: 14px;
        background: rgba(6, 10, 24, 0.85);
        border: 1px solid rgba(120, 160, 220, 0.3);
        backdrop-filter: blur(10px);
        z-index: 20;
        animation: slideRight 0.3s ease-out;
        box-shadow: 4px 0 20px rgba(0, 20, 60, 0.4);
        pointer-events: auto;
      }
      
      @keyframes slideRight {
        from { 
          opacity: 0; 
          transform: translateY(-50%) translateX(-20px); 
        }
        to { 
          opacity: 1; 
          transform: translateY(-50%) translateX(0); 
        }
      }
      
      /* ============================================
         SLOTS - Shared Styling
         ============================================ */
      .inv-slot, .equip-slot {
        width: 48px;
        height: 48px;
        border-radius: 10px;
        background: linear-gradient(145deg, rgba(25, 35, 65, 0.8), rgba(15, 22, 45, 0.9));
        border: 2px solid rgba(100, 140, 200, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s ease-out;
        position: relative;
        font-size: 22px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 
                    0 2px 4px rgba(0,0,0,0.2);
      }
      
      .inv-slot:hover, .equip-slot:hover {
        border-color: rgba(140, 190, 255, 0.65);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 
                    0 0 15px rgba(100, 160, 255, 0.35),
                    0 3px 6px rgba(0,0,0,0.25);
        background: linear-gradient(145deg, rgba(30, 45, 80, 0.85), rgba(20, 30, 60, 0.9));
      }
      
      .inv-slot:active, .equip-slot:active {
        transform: scale(0.96);
      }
      
      .inv-slot.has-item, .equip-slot.has-item {
        border-color: rgba(100, 160, 220, 0.5);
      }
      
      .inv-slot.drag-over, .equip-slot.drag-over {
        border-color: rgba(180, 220, 255, 0.9);
        box-shadow: 0 0 20px rgba(140, 200, 255, 0.6),
                    inset 0 0 15px rgba(140, 200, 255, 0.15);
        transform: scale(1.08);
        background: linear-gradient(145deg, rgba(40, 60, 100, 0.9), rgba(25, 40, 75, 0.95));
      }
      
      .slot-icon {
        font-size: 22px;
        opacity: 0.95;
        text-shadow: 0 2px 6px rgba(0,0,0,0.5);
        filter: drop-shadow(0 1px 1px rgba(0,0,0,0.3));
      }
      
      /* ============================================
         SLOT LABELS
         ============================================ */
      .slot-label {
        position: absolute;
        font-size: 9px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: rgba(180, 200, 255, 0.7);
        white-space: nowrap;
        pointer-events: none;
      }
      
      .inv-slot .slot-label {
        bottom: -18px;
        left: 50%;
        transform: translateX(-50%);
      }
      
      .equip-slot .slot-label {
        top: -18px;
        left: 50%;
        transform: translateX(-50%);
      }
      
      /* ============================================
         ITEM COUNT BADGE
         ============================================ */
      .item-count {
        position: absolute;
        bottom: 2px;
        right: 4px;
        font-size: 10px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.95);
        text-shadow: 0 1px 2px rgba(0,0,0,0.8);
        pointer-events: none;
      }
      
      /* ============================================
         RARITY BORDERS - Enhanced with glow effects
         ============================================ */
      .item-rarity-common { 
        border-color: rgba(150, 160, 170, 0.55) !important; 
      }
      
      .item-rarity-uncommon { 
        border-color: rgba(80, 200, 120, 0.65) !important; 
        box-shadow: 0 0 8px rgba(80, 200, 120, 0.25),
                    inset 0 0 6px rgba(80, 200, 120, 0.1);
      }
      
      .item-rarity-rare { 
        border-color: rgba(100, 140, 255, 0.75) !important; 
        box-shadow: 0 0 12px rgba(100, 140, 255, 0.35),
                    inset 0 0 8px rgba(100, 140, 255, 0.15);
        animation: rareGlow 2s ease-in-out infinite;
      }
      
      @keyframes rareGlow {
        0%, 100% { box-shadow: 0 0 12px rgba(100, 140, 255, 0.35), inset 0 0 8px rgba(100, 140, 255, 0.15); }
        50% { box-shadow: 0 0 18px rgba(100, 140, 255, 0.5), inset 0 0 10px rgba(100, 140, 255, 0.2); }
      }
      
      .item-rarity-legendary { 
        border-color: rgba(255, 180, 50, 0.85) !important; 
        box-shadow: 0 0 18px rgba(255, 180, 50, 0.5), 
                    inset 0 0 10px rgba(255, 180, 50, 0.2);
        animation: legendaryGlow 1.5s ease-in-out infinite;
      }
      
      @keyframes legendaryGlow {
        0%, 100% { 
          box-shadow: 0 0 18px rgba(255, 180, 50, 0.5), inset 0 0 10px rgba(255, 180, 50, 0.2); 
          border-color: rgba(255, 180, 50, 0.85);
        }
        50% { 
          box-shadow: 0 0 25px rgba(255, 200, 80, 0.7), inset 0 0 15px rgba(255, 200, 80, 0.3); 
          border-color: rgba(255, 210, 100, 0.95);
        }
      }
      
      .item-rarity-quest { 
        border-color: rgba(180, 100, 255, 0.8) !important; 
        box-shadow: 0 0 14px rgba(180, 100, 255, 0.4),
                    inset 0 0 8px rgba(180, 100, 255, 0.15);
        animation: questGlow 2.5s ease-in-out infinite;
      }
      
      @keyframes questGlow {
        0%, 100% { box-shadow: 0 0 14px rgba(180, 100, 255, 0.4), inset 0 0 8px rgba(180, 100, 255, 0.15); }
        50% { box-shadow: 0 0 20px rgba(200, 130, 255, 0.55), inset 0 0 12px rgba(200, 130, 255, 0.2); }
      }
      
      /* ============================================
         TOOLTIP
         ============================================ */
      #itemTooltip {
        position: absolute;
        z-index: 100;
        padding: 10px 14px;
        border-radius: 12px;
        background: rgba(8, 12, 28, 0.95);
        border: 1px solid rgba(140, 190, 255, 0.4);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
        font-size: 12px;
        color: rgba(230, 240, 255, 0.95);
        pointer-events: none;
        display: none;
        max-width: 220px;
        backdrop-filter: blur(8px);
      }
      
      #itemTooltip .tooltip-name {
        font-weight: 600;
        font-size: 14px;
        margin-bottom: 4px;
      }
      
      #itemTooltip .tooltip-type {
        font-size: 11px;
        color: rgba(140, 180, 220, 0.85);
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      
      #itemTooltip .tooltip-stats {
        font-size: 11px;
        opacity: 0.9;
        line-height: 1.5;
        margin-bottom: 8px;
      }
      
      #itemTooltip .tooltip-stats div {
        color: rgba(160, 220, 180, 0.95);
      }
      
      #itemTooltip .tooltip-desc {
        font-size: 10px;
        color: rgba(180, 190, 210, 0.7);
        font-style: italic;
        line-height: 1.4;
      }
      
      /* ============================================
         DRAG GHOST
         ============================================ */
      #dragGhost {
        position: fixed;
        z-index: 200;
        width: 48px;
        height: 48px;
        border-radius: 10px;
        background: rgba(20, 30, 60, 0.85);
        border: 2px solid rgba(140, 190, 255, 0.7);
        box-shadow: 0 0 20px rgba(100, 160, 255, 0.5);
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        font-size: 22px;
        transform: translate(-50%, -50%);
      }
      
      /* ============================================
         DROP ZONE (Discard)
         ============================================ */
      #dropZone {
        position: fixed;
        left: 50%;
        top: 50%;
        width: 200px;
        height: 200px;
        border-radius: 50%;
        border: 3px dashed rgba(255, 100, 100, 0.6);
        background: rgba(255, 50, 50, 0.1);
        transform: translate(-50%, -50%);
        display: none;
        align-items: center;
        justify-content: center;
        font-family: 'Segoe UI', sans-serif;
        font-size: 14px;
        font-weight: 500;
        color: rgba(255, 100, 100, 0.8);
        text-align: center;
        pointer-events: none;
        z-index: 150;
      }
      
      #dropZone.active {
        display: flex;
        animation: dropPulse 1s ease-in-out infinite;
      }
      
      @keyframes dropPulse {
        0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.6; }
        50% { transform: translate(-50%, -50%) scale(1.05); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  private setupEventListeners(): void {
    // Inventory slots
    const invSlots = this.inventoryPanel.querySelectorAll('.inv-slot');
    invSlots.forEach((slot) => {
      this.setupSlotEvents(slot as HTMLElement, 'inventory');
    });
    
    // Equipment slots
    const equipSlots = this.equipmentPanel.querySelectorAll('.equip-slot');
    equipSlots.forEach((slot) => {
      this.setupSlotEvents(slot as HTMLElement, 'equipment');
    });
    
    // Global mouse events for drag
    document.addEventListener('mousemove', (e) => this.onDrag(e));
    document.addEventListener('mouseup', (e) => this.onDragEnd(e));
  }

  private setupSlotEvents(slot: HTMLElement, type: 'inventory' | 'equipment'): void {
    slot.addEventListener('mouseenter', (e) => this.showTooltip(e, slot, type));
    slot.addEventListener('mouseleave', () => this.hideTooltip());
    slot.addEventListener('mousedown', (e) => this.onDragStart(e, slot, type));
    slot.addEventListener('mouseup', (e) => this.onDrop(e, slot, type));
    slot.addEventListener('dragover', (e) => e.preventDefault());
    
    // Right-click to quick equip/unequip, Shift+Right-click to drop
    slot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onRightClick(slot, type, e.shiftKey);
    });
  }

  private onRightClick(slot: HTMLElement, type: 'inventory' | 'equipment', shiftKey: boolean = false): void {
    const itemId = this.getSlotItem(slot, type);
    if (!itemId) return;
    
    const item = ITEM_DATA.get(itemId);
    if (!item) return;
    
    // Shift+Right-click: Drop item to world
    if (shiftKey && type === 'inventory') {
      const index = parseInt(slot.dataset.slot || '0');
      this.onDropItem?.(index);
      this.hideTooltip();
      return;
    }
    
    if (type === 'inventory') {
      // Right-click on inventory: auto-equip to appropriate slot
      const index = parseInt(slot.dataset.slot || '0');
      let targetSlot: string | null = null;
      
      if (item.type === 'weapon') {
        // Prefer empty weapon slot, or leftWeapon if both occupied
        if (!this.equipment.leftWeapon) {
          targetSlot = 'leftWeapon';
        } else if (!this.equipment.rightWeapon) {
          targetSlot = 'rightWeapon';
        } else {
          targetSlot = 'leftWeapon'; // Swap with left weapon
        }
      } else if (item.type === 'booster') {
        targetSlot = 'booster';
      } else if (item.type === 'cockpit') {
        targetSlot = 'cockpit';
      }
      
      if (targetSlot) {
        this.onEquip?.(index, targetSlot);
        this.hideTooltip();
      }
    } else {
      // Right-click on equipment: unequip to first available inventory slot
      const equipSlotName = slot.dataset.slot as string;
      this.onUnequip?.(equipSlotName);
      this.hideTooltip();
    }
  }

  private getSlotItem(slot: HTMLElement, type: 'inventory' | 'equipment'): string | null {
    if (type === 'inventory') {
      const index = parseInt(slot.dataset.slot || '0');
      const inv = this.inventory[index];
      return inv?.itemId || null;
    } else {
      const slotName = slot.dataset.slot as keyof EquipmentSlots;
      return this.equipment[slotName];
    }
  }

  private showTooltip(e: MouseEvent, slot: HTMLElement, type: 'inventory' | 'equipment'): void {
    if (this.isDragging) return;
    
    const itemId = this.getSlotItem(slot, type);
    if (!itemId) return;
    
    const item = ITEM_DATA.get(itemId);
    if (!item) return;
    
    const rarityColor = RARITY_COLORS[item.rarity] || '#b8c8e8';
    
    let statsHtml = '';
    if (item.damage !== undefined) {
      statsHtml += `<div>⚔️ Damage: ${item.damage}x</div>`;
    }
    if (item.fireRate !== undefined) {
      statsHtml += `<div>🔥 Fire Rate: ${item.fireRate}x</div>`;
    }
    if (item.weaponType) {
      statsHtml += `<div>📦 Type: ${item.weaponType}</div>`;
    }
    
    this.tooltip.innerHTML = `
      <div class="tooltip-name" style="color: ${rarityColor}">${item.name}</div>
      <div class="tooltip-type">${item.type} • Tier ${item.tier}</div>
      ${statsHtml ? `<div class="tooltip-stats">${statsHtml}</div>` : ''}
      <div class="tooltip-desc">${item.description}</div>
    `;
    
    this.tooltip.style.display = 'block';
    this.positionTooltip(e.clientX, e.clientY);
  }

  private positionTooltip(x: number, y: number): void {
    const rect = this.tooltip.getBoundingClientRect();
    const padding = 15;
    
    let left = x + padding;
    let top = y + padding;
    
    if (left + rect.width > window.innerWidth) {
      left = x - rect.width - padding;
    }
    if (top + rect.height > window.innerHeight) {
      top = y - rect.height - padding;
    }
    
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  private hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }

  private onDragStart(e: MouseEvent, slot: HTMLElement, type: 'inventory' | 'equipment'): void {
    if (e.button !== 0) return; // Left click only
    
    const itemId = this.getSlotItem(slot, type);
    if (!itemId) return;
    
    const item = ITEM_DATA.get(itemId);
    if (!item) return;
    
    this.isDragging = true;
    
    // Setup drag ghost
    const tierColor = TIER_COLORS[item.tier] || 'rgba(100, 140, 200, 0.4)';
    this.dragGhost.style.borderColor = tierColor;
    this.dragGhost.innerHTML = `<span class="slot-icon">${getItemIcon(item.type, item.weaponType)}</span>`;
    this.dragGhost.style.display = 'flex';
    this.dragGhost.style.left = `${e.clientX}px`;
    this.dragGhost.style.top = `${e.clientY}px`;
    
    if (type === 'inventory') {
      this.draggedSlot = { type, index: parseInt(slot.dataset.slot || '0') };
    } else {
      this.draggedSlot = { type, index: slot.dataset.slot || '' };
    }
    
    // Show drop zone for inventory items
    if (type === 'inventory') {
      this.dropZone.classList.add('active');
    }
    
    this.hideTooltip();
    e.preventDefault();
  }

  private onDrag(e: MouseEvent): void {
    if (!this.isDragging) return;
    
    this.dragGhost.style.left = `${e.clientX}px`;
    this.dragGhost.style.top = `${e.clientY}px`;
    
    // Highlight valid drop targets
    const allSlots = document.querySelectorAll('.inv-slot, .equip-slot');
    allSlots.forEach((slot) => slot.classList.remove('drag-over'));
    
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = target?.closest('.inv-slot, .equip-slot') as HTMLElement;
    if (slotEl && this.isValidDropTarget(slotEl)) {
      slotEl.classList.add('drag-over');
    }
  }

  private onDragEnd(e: MouseEvent): void {
    if (!this.isDragging) return;
    
    // Check if dropped on drop zone (discard)
    if (this.draggedSlot?.type === 'inventory') {
      const dropRect = this.dropZone.getBoundingClientRect();
      const centerX = dropRect.left + dropRect.width / 2;
      const centerY = dropRect.top + dropRect.height / 2;
      const dist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
      
      if (dist < 100) {
        this.onDropItem?.(this.draggedSlot.index as number);
      }
    }
    
    this.dragGhost.style.display = 'none';
    this.dropZone.classList.remove('active');
    this.isDragging = false;
    
    const allSlots = document.querySelectorAll('.inv-slot, .equip-slot');
    allSlots.forEach((slot) => slot.classList.remove('drag-over'));
    
    this.draggedSlot = null;
  }

  private onDrop(e: MouseEvent, slot: HTMLElement, type: 'inventory' | 'equipment'): void {
    if (!this.draggedSlot) return;
    
    const fromType = this.draggedSlot.type;
    const fromIndex = this.draggedSlot.index;
    
    if (type === 'equipment') {
      const toSlot = slot.dataset.slot as string;
      
      if (fromType === 'inventory') {
        // Equip from inventory
        this.onEquip?.(fromIndex as number, toSlot);
      }
    } else if (type === 'inventory') {
      const toIndex = parseInt(slot.dataset.slot || '0');
      
      if (fromType === 'inventory') {
        // Swap inventory slots
        if (fromIndex !== toIndex) {
          this.onSwapInventory?.(fromIndex as number, toIndex);
        }
      } else if (fromType === 'equipment') {
        // Unequip to inventory
        this.onUnequip?.(fromIndex as string);
      }
    }
  }

  private isValidDropTarget(slot: HTMLElement): boolean {
    if (!this.draggedSlot) return false;
    
    if (slot.classList.contains('equip-slot')) {
      // Check if dragged item can go in this equipment slot
      if (this.draggedSlot.type === 'inventory') {
        const inv = this.inventory[this.draggedSlot.index as number];
        if (!inv?.itemId) return false;
        
        const item = ITEM_DATA.get(inv.itemId);
        if (!item) return false;
        
        const slotType = slot.dataset.type;
        if (slotType === 'weapon' && item.type === 'weapon') return true;
        if (slotType === item.type) return true;
        return false;
      }
    } else if (slot.classList.contains('inv-slot')) {
      return true; // Can always drop to inventory
    }
    
    return false;
  }

  update(inventory: InventorySlot[], equipment: EquipmentSlots): void {
    this.inventory = inventory;
    this.equipment = equipment;
    this.render();
  }

  private render(): void {
    // Render inventory slots
    const invSlots = this.inventoryPanel.querySelectorAll('.inv-slot');
    invSlots.forEach((slotEl, index) => {
      const slot = slotEl as HTMLElement;
      const inv = this.inventory[index];
      
      // Clear classes
      slot.className = 'inv-slot';
      
      if (inv?.itemId) {
        const item = ITEM_DATA.get(inv.itemId);
        if (item) {
          slot.classList.add('has-item');
          slot.classList.add(`item-rarity-${item.rarity}`);
          slot.innerHTML = `
            <span class="slot-icon">${getItemIcon(item.type, item.weaponType)}</span>
            ${inv.count > 1 ? `<span class="item-count">x${inv.count}</span>` : ''}
          `;
        } else {
          slot.innerHTML = '';
        }
      } else {
        slot.innerHTML = '';
      }
    });
    
    // Render equipment slots
    const equipSlots = this.equipmentPanel.querySelectorAll('.equip-slot');
    equipSlots.forEach((slotEl) => {
      const slot = slotEl as HTMLElement;
      const slotName = slot.dataset.slot as keyof EquipmentSlots;
      const label = slot.querySelector('.slot-label')?.outerHTML || '';
      const itemId = this.equipment[slotName];
      
      // Reset classes but keep slot-label
      slot.className = 'equip-slot';
      
      if (itemId) {
        const item = ITEM_DATA.get(itemId);
        if (item) {
          slot.classList.add('has-item');
          slot.classList.add(`item-rarity-${item.rarity}`);
          slot.innerHTML = `
            ${label}
            <span class="slot-icon">${getItemIcon(item.type, item.weaponType)}</span>
          `;
        } else {
          slot.innerHTML = label;
        }
      } else {
        slot.innerHTML = label;
      }
    });
  }

  show(): void {
    this.visible = true;
    this.inventoryPanel.style.display = 'flex';
    this.equipmentPanel.style.display = 'flex';
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.inventoryPanel.style.display = 'none';
    this.equipmentPanel.style.display = 'none';
    this.hideTooltip();
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
