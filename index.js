'use strict';

var DataSourceIndexed = require('datasaur-indexed');


var DEPTH = '__DEPTH';
var EXPAND = '__EXPANDED';
var requiredProps = ['idColumnIndex', 'parentIdColumnIndex', 'treeColumnIndex', 'groupColumnIndex'];

/** @typedef columnAddress
 * @property {string} name - The name of a column listed in the fields array. See the {@link DataSourceTreeview#getFields|getFields()} method.
 * @property {number} index - The index of the column in the fields array. See the {@link DataSourceTreeview#getFields|getFields()} method.
 */


/**
 * @classdesc For proper sorting, include `DataSourceTreeviewSorter` in your data source pipeline, _ahead of_ (closer to the data than) this data source.
 *
 * For proper filtering, include `DataSourceTreeviewFilter` in your data source pipeline, _ahead of_ `DataSourceTreeviewSorter`, if included; or at any rate ahead of this data source.
 * @constructor
 * @param dataSource
 * @extends DataSourceIndexed
 */
var DataSourceTreeview = DataSourceIndexed.extend('DataSourceTreeview', {

    /**
     * @summary Toggle the tree-view.
     * @desc Calculates or recalculates nesting depth of each row and marks it as "expandable" iff it has children.
     *
     * If resetting previously set data, the state of expansion of all rows that still have children is retained.
     * (All expanded rows will still be expanded when tree-view is turned back *ON*.)
     *
     * @param {boolean|object} [enable] - Turns tree-view **ON** if all four columns must exist.
     * @returns {boolean} Joined state.
     *
     * @memberOf DataSourceTreeview#
     */
    set join(enable) {
        var schema = this.getSchema();

        /** @summary Reference to the primary key column address object.
         * @desc The primary key column uniquely identifies a data row.
         * Used to relate a child row to a parent row.
         * @param {number|string} indexOrName
         * @returns {columnAddress} Getter returns column address object; setter however always returns its input.
         */
        if (this.idColumnIndex === undefined) {
            this.idColumnIndex = schema.ID;
        }

        /** @summary Reference to the foreign key column address object.
         * @desc The foreign key column defines grouping; it relates this tree node row to its parent tree node row.
         * Top-level tree nodes have no parent.
         * In that case the value in the column is `null`.
         * @param {number|string} indexOrName
         * @returns {columnAddress} Getter returns column address object; setter however always returns its input.
         */
        if (this.parentIdColumnIndex === undefined) {
            this.parentIdColumnIndex = schema.parentID;
        }

        /** @summary Reference to the drill-down column address object.
         * @desc The drill-down column is the column that is indented and decorated with drill-down controls (triangles). A column with the given index or name must exist.
         * @param {number|string} indexOrName
         * @returns {columnAddress} Getter returns column address object; setter however always returns its input.
         */
        if (this.treeColumnIndex === undefined) {
            this.treeColumnIndex = schema.name;
        }

        /**
         /** @summary Reference to the group name column address object.
         * @desc The group name column is the column whose content describes the group. A column with the given index or name must exist.
         *
         * The treeview sorter treats the group name column differently than other columns,
         * apply a "group sort" to it, which means only the group rows (rows with children)
         * are sorted and the leaves are left alone (stable sorted).
         *
         * Normally refers to the same column as {@link DataSourceTreeview#treeColumn|treeColumn}.
         * @param {number|string} indexOrName
         * @returns {columnAddress} Getter returns column address object; setter however always returns its input.
         */
        if (this.groupColumnIndex === undefined) {
            this.groupColumnIndex = this.treeColumnIndex;
        }

        var undefineds = requiredProps.filter(function(key) { return this[key] === undefined; }, this).join(' and ');
        if (undefineds) {
            throw new this.DataSourceError('Expected ' + undefineds + ' properties to be defined.');
        }

        // successful join requires that all columns exist
        this.joined = enable;

        this.buildIndex(); // make all rows visible to getRow()

        var underlyingDataSource = this.next;
        var r = this.getRowCount();

        if (this.joined) {
            var row, ID;

            // Add __DEPTH metadatum to all rows and __EXPANDED metadatum to all "parent" rows
            this.maxDepth = 0;
            while (r--) {
                var depth = 0;

                for (
                    var parentID, parentRowIndex = r;
                    (parentID = underlyingDataSource.getValue(this.parentIdColumnIndex, parentRowIndex)) != null;
                    parentRowIndex = this.findRowIndexByID(parentID)
                ) {
                    depth += 1;
                }

                if (this.maxDepth < depth) {
                    this.maxDepth = depth;
                }

                row = underlyingDataSource.getRowMetadata(r, {});
                row[DEPTH] = depth;

                ID = underlyingDataSource.getValue(this.idColumnIndex, r);
                if (!this.findRowByParentID(ID)) {
                    delete row[EXPAND]; // no longer expandable
                } else if (row[EXPAND] === undefined) { // retain previous setting for old rows
                    row[EXPAND] = false; // default for new row is unexpanded
                }
            }
        } else {
            // flatten the tree so group sorter sees it as a single group
            while (r--) {
                underlyingDataSource.getRowMetadata(r, {})[DEPTH] = 0;
            }
        }
    },
    get join() {
        return this.joined;
    },

    /**
     * @summary Rebuild the index.
     * @desc Rebuild the index to show only "revealed" rows. (Rows that are not inside a collapsed parent node row.)
     * @memberOf DataSourceTreeview#
     */
    apply: function() {
        if (!this.viewMakesSense()) {
            this.clearIndex();
        } else {
            this.buildIndex(rowIsRevealed);
        }
    },

    /**
     * @summary Get the value for the specified cell.
     * @desc Intercepts tree column values and indents and decorates them.
     * @param x
     * @param y
     * @returns {*}
     * @memberOf DataSourceTreeview#
     */
    getValue: function(x, y) {
        var value = DataSourceIndexed.prototype.getValue.call(this, x, y);

        if (this.viewMakesSense() && x === this.treeColumnIndex) {
            var row = this.getRowMetadata(y);

            if (!(value === '' && row[EXPAND] === undefined)) {
                value = Array(row[DEPTH] + 1).join(this.drillDownCharMap.null) + this.drillDownCharMap[row[EXPAND]] + value;
            }
        }

        return value;
    },

    viewMakesSense: function() {
        return this.joined;
    },
    /**
     * @memberOf DataSourceTreeview#
     * @param {number} columnIndex
     * @returns {*|boolean}
     */
    isDrillDown: function(columnIndex) {
        var result = this.viewMakesSense();

        if (result && columnIndex !== undefined) {
            result = columnIndex === this.treeColumnIndex;
        }

        return result;
    },

    /**
     * @summary Handle a click event in the drill-down column.
     *
     * @desc Operates only on the following rows:
     * * Expandable rows - Rows with a drill-down control.
     * * Revealed rows - Rows not hidden inside of collapsed drill-downs.
     *
     * If and ony if the click results in a drill-down toggle (row had a drill-down _and_ state changed), triggers the 'data-rows-changed' event to which the listener should respond by calling `apply()`.
     *
     * The reason we don't call `apply()` immediately from here is to give caller a chance to do any needed before and after housekeeping chores.
     *
     * @param y - Revealed row number. (This is not the row ID.)
     *
     * @param {boolean} [expand] - One of:
     * * `undefined` (or omitted) - Toggle row.
     * * `true` - Expand row iff currently collapsed.
     * * `false` - Collapse row iff currently expanded.
     *
     * @returns {boolean} Click was consumed.
     *
     * @memberOf DataSourceTreeview#
     */
    click: function(y, expand) {
        if (!this.isDrillDown()) {
            return this.next.click(y, expand);
        }

        var changed, clickable,
            row = this.getRowMetadata(y);

        if (row && row[EXPAND] !== undefined) {
            if (expand === undefined) {
                expand = !row[EXPAND];
            }
            if (row[EXPAND] !== expand) {
                row[EXPAND] = expand;
                this.apply();
                return true;
            }
        }
    },

    /**
     * @summary Expand nested drill-downs containing this row.
     * @param ID - The unique row ID.
     * @returns {boolean} If any rows expanded.
     * @memberOf DataSourceTreeview#
     */
    revealRow: function(ID) {
        var r, parent,
            changed = false,
            underlyingDataSource = this.next;

        if (!this.viewMakesSense()) {
            return underlyingDataSource.revealRow.apply(underlyingDataSource, arguments);
        }

        while ((r = this.findRowIndexByID(ID)) !== undefined) {
            if (parent) {
                row = this.getRowMetadata(r);
                if (row[EXPAND] === false) {
                    row[EXPAND] = changed = true;
                }
            }
            parent = true;
            ID = underlyingDataSource.getValue(this.parentIdColumnIndex, ID);
        }
        return changed;
    }
});

function rowIsRevealed(r) {
    var parentID;
    var underlyingDataSource = this.next;

    // are any of the row's ancestors collapsed?
    while ((parentID = underlyingDataSource.getValue(this.parentIdColumnIndex, r)) != null) {
        // walk up through each parent...
        r = this.findRowIndexByID(parentID);
        if (underlyingDataSource.getRowMetadata(r)[EXPAND] === false) { // an ancestor is collapsed
            return false; // exclude row from build
        }
    }

    // no ancestors were collapsed
    return true; // include row in build
}

// read-only property
Object.defineProperty(DataSourceTreeview.prototype, 'name', { value: 'treeviewer' });

module.exports = DataSourceTreeview;
