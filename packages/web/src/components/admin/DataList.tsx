import { useState, type ReactNode } from 'react';

export interface DataListColumn<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /**
   * Extra columns that stay visible on desktop but are hidden on mobile until
   * the row is expanded.
   */
  mobileCollapsed?: boolean;
}

interface DataListProps<T> {
  columns: DataListColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  testId?: string;
  actionsLabel?: string;
  /** Rendered inside the actions cell; group danger ops after a `.danger-sep`. */
  actions?: (row: T) => ReactNode;
  expandable?: boolean;
  expandedRow?: (row: T) => ReactNode;
  className?: string;
}

/**
 * Responsive table/card list. Renders one table; on small screens CSS turns
 * each row into a card with key-value cells (labels come from `data-label`),
 * extra columns hidden behind an expand toggle, and actions grouped at the
 * bottom. Desktop keeps the plain table. Both layouts share the same DOM, so
 * tests assert structure and the mobile behaviour is pure CSS. Cell values are
 * rendered directly (no wrapper element) so table-scoped locators keep working.
 */
export function DataList<T>({ columns, rows, rowKey, testId, actionsLabel = '操作', actions, expandable = false, expandedRow, className }: DataListProps<T>) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <table className={`data-list${className ? ` ${className}` : ''}`} data-testid={testId}>
      <thead>
        <tr>
          {columns.map((column) => <th key={column.key}>{column.label}</th>)}
          {actions && <th>{actionsLabel}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          const isExpanded = expanded.has(key);
          return (
            <RowGroup
              key={key}
              isExpanded={isExpanded}
              toggle={() => toggle(key)}
              columns={columns}
              row={row}
              actions={actions}
              actionsLabel={actionsLabel}
              expandable={expandable}
              expandedRow={expandedRow}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function RowGroup<T>({ isExpanded, toggle, columns, row, actions, actionsLabel, expandable, expandedRow }: {
  isExpanded: boolean;
  toggle: () => void;
  columns: DataListColumn<T>[];
  row: T;
  actions?: (row: T) => ReactNode;
  actionsLabel: string;
  expandable: boolean;
  expandedRow?: (row: T) => ReactNode;
}) {
  return (
    <>
      <tr className={isExpanded ? 'expanded' : undefined}>
        {columns.map((column, index) => (
          <td
            key={column.key}
            data-label={column.label}
            data-collapse-on-mobile={column.mobileCollapsed ? 'true' : undefined}
            className={index === 0 ? 'data-list-primary' : undefined}
          >
            {column.render(row)}
            {index === 0 && expandable && (
              <button
                type="button"
                className="data-list-expand"
                aria-expanded={isExpanded}
                aria-label={isExpanded ? '收起详情' : '展开详情'}
                onClick={toggle}
              >
                {isExpanded ? '收起' : '详情'}
              </button>
            )}
          </td>
        ))}
        {actions && (
          <td data-label={actionsLabel} className="data-list-actions">
            {actions(row)}
          </td>
        )}
      </tr>
      {expandedRow && isExpanded && (
        <tr className="data-list-detail">
          <td colSpan={columns.length + (actions ? 1 : 0)}>{expandedRow(row)}</td>
        </tr>
      )}
    </>
  );
}
