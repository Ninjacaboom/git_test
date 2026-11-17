import { useEffect, useState } from 'react';
import { getMembers, type Member } from './api';

const KEY = 'nova.viewingAs';

/**
 * The member the site is being viewed as. For now it is picked from a dropdown; once the site
 * lives inside the NOVA portal, this is the one place to read the portal's signed-in member instead.
 */
export function useCurrentMember() {
  const [members, setMembers] = useState<Member[]>([]);
  const [currentId, setCurrentId] = useState<string>(() => {
    try {
      return localStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    getMembers().then(setMembers).catch(() => setMembers([]));
  }, []);

  function choose(id: string) {
    setCurrentId(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // storage unavailable: the choice just lasts until reload
    }
  }

  const current = members.find((m) => m.id === currentId) ?? null;
  return { members, current, choose };
}
