// This is the Frankenstein's monster review completion condition that is
// stitched together from the various built-in Reviewable examples :-)

// Summary: A review is considered approved when any of:
// 1. All files have been reviewed by at least one user and all discussions have
//    been resolved
// 2. has been approved via LGTM emojis by a minimum number of reviewers and by
//    all requested reviewers (or all assignees instead, if no reviewers were
//    requested), and there are no blocking or holding discussions
// 3. has been approved via GitHub review approval by a minimum number of reviewers
//    and by all assignees, and no changes were requested by any reviewers.
//
// Note about Reviewable's LGTM emojis:
// Approval is granted via the :lgtm: and :lgtm_strong: emojis,
// and can be withdrawn with :lgtm_cancel:.  An :lgtm: is only
// good for the last non-provisional revision at the time the
// comment is sent, so any new commits will require another
// approval.  An :lgtm_strong: is good for all revisions unless
// canceled.


// How this works: this is the body of a function that gets a `review` object as parameter.

// Settings:
// The number of approvals/LGTMs required to merge if there are no PR assignees.
const DEFAULT_NUM_APPROVALS_REQUIRED = 1;


// 1. All files have been reviewed and all discussions have been resolved
function all_reviewed_and_resolved(review) {
    let reasons = [];     // pieces of the status description
    let shortReasons = [];   // pieces of the short status desc.
    const summary = review.summary;  // shortcut to summary
    const designatedReviewers =
          _.isEmpty(review.pullRequest.requestedReviewers) ?
          review.pullRequest.assignees :
          review.pullRequest.requestedReviewers;

    const completed =
        !summary.numUnreviewedFiles &&
        !summary.numUnresolvedDiscussions;

    if (summary.numUnreviewedFiles) {
        reasons.push(
            (summary.numFiles - summary.numUnreviewedFiles) +
                ' of ' + summary.numFiles + ' files reviewed');
        shortReasons.push(
            summary.numUnreviewedFiles + ' file' +
                (summary.numUnreviewedFiles > 1 ? 's' : '')
        );
    } else {
        reasons.push('all files reviewed');
    }

    if (summary.numUnresolvedDiscussions) {
        reasons.push(
            summary.numUnresolvedDiscussions +
                ' unresolved discussion' +
                (summary.numUnresolvedDiscussions > 1 ? 's' : ''));
        shortReasons.push(
            summary.numUnresolvedDiscussions + ' discussion' +
                (summary.numUnresolvedDiscussions > 1 ? 's' : '')
        );
    } else {
        reasons.push('all discussions resolved');
    }

    const discussionBlockers = _(review.discussions)
          .filter({resolved: false})
          .map('participants')
          .flatten()
          .filter({resolved: false})
          .map(user => _.pick(user, 'username'))
          .value();

    const lastReviewedRevisionsOfUnreviewedFiles = _(review.files)
          .filter(file => {
              let rev = _(file.revisions).reject('obsolete').last();
              if (!rev) rev = _.last(file.revisions);
              return _.isEmpty(rev.reviewers);
          }).map(file => _.findLast(
              file.revisions, rev => !_.isEmpty(rev.reviewers)))
          .value();

    const fileBlockers = _(lastReviewedRevisionsOfUnreviewedFiles)
          .compact()
          .map('reviewers')
          .flatten()
          .value();

    const missingReviewers =
          _.some(lastReviewedRevisionsOfUnreviewedFiles, rev => !rev) ?
          designatedReviewers :
          _.filter(designatedReviewers, {participating: false});

    const pendingReviewers = _(fileBlockers)
          .concat(discussionBlockers)
          .concat(missingReviewers)
          .map(user => _.pick(user, 'username'))
          .uniq('username')
          .value();

    const mergeability = review.pullRequest.mergeability;
    if (_.isEmpty(pendingReviewers)) {
        const readyToMerge = review.pullRequest.target.branchProtected ?
              _.includes(['has_hooks', 'clean', 'unstable'], mergeability) :
              completed && mergeability !== 'draft' && _.every(
                  review.pullRequest.checks, check => !check.required || check.success);
        if (readyToMerge) pendingReviewers.push(review.pullRequest.author);
    }

    let shortDescription;
    if (completed) {
        shortDescription =
            summary.numFiles + ' file' +
            (summary.numFiles > 1 ? 's' : '') + ' reviewed';
    } else {
        shortDescription = shortReasons.join(', ') + ' left';
    }

    return {
        completed,
        description: reasons.join(', '),
        shortDescription,
        pendingReviewers
    };
}


// 2. LGTM'd, and no blocking or holding discussions
function reviewable_lgtm() {
    // Approval by username: true if current LGTM, false if stale,
    // missing if not given or canceled.
    const approvals = {};

    const debug = {};

    // Timestamp of the currently latest revision.
    const lastRevisionTimestamp =
          _(review.revisions).reject('obsolete').last().snapshotTimestamp;

    debug['emojis'] = [];
    _.forEach(review.sentiments, function(sentiment) {
        const emojis = _.indexBy(sentiment.emojis, x => x);
        debug['emojis'].push.apply(emojis);
        if (emojis.lgtm_cancel) {
            delete approvals[sentiment.username];
        } else if (emojis.lgtm_strong) {
            approvals[sentiment.username] = true;
        } else if (emojis.lgtm && !approvals[sentiment.username]) {
            approvals[sentiment.username] =
                sentiment.timestamp >= lastRevisionTimestamp;
        }
    });

    const numApprovals = _.countBy(approvals);
    let numGranted = numApprovals.true || 0;
    let pendingReviewers = [];

    const designatedReviewers =
          _.isEmpty(review.pullRequest.requestedReviewers) ?
          review.pullRequest.assignees :
          review.pullRequest.requestedReviewers;
    const required = _.map(designatedReviewers, 'username');
    let numApprovalsRequired;
    if (required.length) {
        numApprovalsRequired =
            _.max([required.length, DEFAULT_NUM_APPROVALS_REQUIRED]);
        numGranted =
            (_(approvals).pick(required).countBy().value().true || 0) +
            _.min([numGranted, DEFAULT_NUM_APPROVALS_REQUIRED - required.length]);
        pendingReviewers = _(required)
            .reject(username => approvals[username])
            .map(username => ({username}))
            .value();
    }

    let description =
        numGranted + ' of ' + numApprovalsRequired + ' LGTMs obtained';
    let shortDescription =
        numGranted + '/' + numApprovalsRequired + ' LGTMs';
    if (numApprovals.false) {
        description += ', and ' + numApprovals.false + ' stale';
        shortDescription += ', ' + numApprovals.false + ' stale';
    }

    return {
        completed: numGranted >= DEFAULT_NUM_APPROVALS_REQUIRED,
        description, shortDescription, pendingReviewers,
        debug: debug
    };
}


function github_approved() {
    // The number of approvals required to merge. Default defined above, otherwise requires assignees
    let numApprovalsRequired = DEFAULT_NUM_APPROVALS_REQUIRED;

    const approvals = review.pullRequest.approvals;

    let numApprovals =
        _.filter(approvals, 'approved').length;
    const numRejections =
          _.filter(approvals, 'changes_requested').length;

    const discussionBlockers = _(review.discussions)
          .filter({resolved: false})
          .map('participants')
          .flatten()
          .filter({resolved: false})
          .map(user => _.pick(user, 'username'))
          .value();

    let pendingReviewers = _(discussionBlockers)
        .map(user => _.pick(user, 'username'))
        .concat(review.pullRequest.requestedReviewers)
        .value();

    const required =
          _.map(review.pullRequest.assignees, 'username');
    _.pull(required, review.pullRequest.author.username);
    if (required.length) {
        numApprovalsRequired =
            _.max([required.length, numApprovalsRequired]);
        numApprovals =
            (_(approvals).pick(required).filter('approved').size()) +
            _.min([numApprovals, numApprovalsRequired - required.length]);
        pendingReviewers = _(required)
            .reject(username => approvals[username] === 'approved')
            .reject(
                username => pendingReviewers.length && approvals[username])
            .map(username => {username})
            .concat(pendingReviewers)
            .value();
    }

    pendingReviewers = _.uniq(pendingReviewers, 'username');

    const description =
          (numRejections ? `${numRejections} change requests, ` : '') +
          `${numApprovals} of ${numApprovalsRequired} approvals obtained`;
    const shortDescription =
          (numRejections ? `${numRejections} ✗, ` : '') +
          `${numApprovals} of ${numApprovalsRequired} ✓`;

    return {
        completed: numApprovals >= numApprovalsRequired,
        description, shortDescription, pendingReviewers
    };
}


function any_satisfied(conditions, review) {
    let results = _.map(conditions, fn => fn(review));
    let satisfied = _.find(results, res => res.completed);
    if (satisfied) {
        return satisfied;
    } else {
        return {
            completed: false,
            description: _.pluck(results, 'description').join(' / '),
            shortDescription: _.pluck(results, 'shortDescription').join(' / '),
            pendingReviewers: _.uniq([].concat(results.pendingReviewers))
        };
    }
}


return any_satisfied([
    all_reviewed_and_resolved,
    reviewable_lgtm,
    github_approved,
], review);
