/** Serializable picker contract. Tokens are opaque; source identities stay in main. */
export type ScreenPickerItem = {
  token: string;
  title: string;
  subtitle?: string;
  thumbnail?: string;
  icon?: string;
};

export type ScreenPickerData = {
  screens: ScreenPickerItem[];
  windows: ScreenPickerItem[];
};

export interface ScreenPickerBridge {
  /** Ask main to reveal the window once the first list has rendered. */
  ready(): void;
  get(): Promise<ScreenPickerData>;
  choose(token: string): void;
  cancel(): void;
}
