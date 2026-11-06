import { createContext, useContext } from 'react';
import type { Bootstrap, CategoryOut } from '@planb/shared';

export interface AppCtx extends Bootstrap { today: string; catMap: Record<string, CategoryOut> }
export const AppContext = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(AppContext);
