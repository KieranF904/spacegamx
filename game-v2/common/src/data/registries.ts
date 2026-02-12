/**
 * Registry Pattern - Base classes for data-driven entity/item/weapon registration
 */

export interface IRegistry<TId extends string, TDefinition> {
  register(id: TId, definition: TDefinition): void;
  get(id: TId): TDefinition | undefined;
  getAll(): Map<TId, TDefinition>;
  has(id: TId): boolean;
  getIds(): TId[];
}

/**
 * Base registry implementation with numeric ID mapping for ECS
 */
export abstract class BaseRegistry<TId extends string, TDef> implements IRegistry<TId, TDef> {
  protected items = new Map<TId, TDef>();
  protected idToNum = new Map<TId, number>();
  protected numToId = new Map<number, TId>();
  private nextNum = 1;

  register(id: TId, definition: TDef): void {
    this.validate(id, definition);
    this.items.set(id, definition);
    
    if (!this.idToNum.has(id)) {
      this.idToNum.set(id, this.nextNum);
      this.numToId.set(this.nextNum, id);
      this.nextNum++;
    }
  }

  get(id: TId): TDef | undefined {
    return this.items.get(id);
  }

  getAll(): Map<TId, TDef> {
    return new Map(this.items);
  }

  has(id: TId): boolean {
    return this.items.has(id);
  }

  getIds(): TId[] {
    return Array.from(this.items.keys());
  }

  getNumericId(id: TId): number {
    return this.idToNum.get(id) ?? 0;
  }

  getStringId(num: number): TId | undefined {
    return this.numToId.get(num);
  }

  getByNum(num: number): TDef | undefined {
    const id = this.numToId.get(num);
    return id ? this.items.get(id) : undefined;
  }

  protected validate(id: TId, definition: TDef): void {}

  loadAll(definitions: TDef[], idExtractor: (def: TDef) => TId): void {
    for (const def of definitions) {
      this.register(idExtractor(def), def);
    }
  }
}
