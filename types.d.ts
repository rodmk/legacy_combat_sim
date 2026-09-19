export interface GearStats {
  min_damage: number;
  max_damage: number;
  armor: number;
  dodge: number;
  accuracy: number;
  speed: number;
  def_skill: number;
  melee_skill: number;
  gun_skill: number;
  proj_skill: number;
}

export interface CrystalDefinition {
  name: string;
  mult: Partial<Record<keyof GearStats, number>>;
}

export type CrystalCatalog = Readonly<Record<string, CrystalDefinition>>;

export type EquipmentStats = Partial<GearStats>;

export type EquipmentDefinition = { name: string } & EquipmentStats;

export type WeaponDefinition = EquipmentDefinition & {
  type: string;
  min_damage: number;
  max_damage: number;
};

export interface EquipmentCatalog {
  armor: Readonly<Record<string, EquipmentDefinition>>;
  weapons: Readonly<Record<string, WeaponDefinition>>;
  miscs: Readonly<Record<string, EquipmentDefinition>>;
}
