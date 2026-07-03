'use client';

/**
 * HeaderNav — responsive renderer for the app header's primary navigation.
 *
 * Split into two slots the layout places independently so each sits where it
 * reads best:
 *
 * - {@link HeaderNavLinks} — inline links beside the brand, shown at `md` and up.
 * - {@link HeaderNavMenu} — a far-right kebab (⋮) dropdown, shown below `md`,
 *   grouped with the header actions (theme toggle, user button).
 *
 * Both take the same resolved items (href / label / icon / active state), which
 * PublicNav / ProtectedNav compute from the route and session.
 */

import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface HeaderNavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
  isActive: boolean;
}

/** Desktop (md+) inline links beside the brand. */
export function HeaderNavLinks({ items }: { items: HeaderNavItem[] }) {
  if (items.length === 0) return null;

  return (
    <nav className="hidden items-center gap-1 md:flex">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              item.isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
            aria-current={item.isActive ? 'page' : undefined}
          >
            {Icon && <Icon className="h-4 w-4" />}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Mobile (below md) far-right kebab dropdown, grouped with the header actions. */
export function HeaderNavMenu({ items }: { items: HeaderNavItem[] }) {
  if (items.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9 md:hidden">
          <MoreVertical className="h-5 w-5" />
          <span className="sr-only">Open navigation menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.href} asChild>
              <Link
                href={item.href}
                className={cn('cursor-pointer', item.isActive && 'text-accent-foreground')}
                aria-current={item.isActive ? 'page' : undefined}
              >
                {Icon && <Icon className="mr-2 h-4 w-4" />}
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
